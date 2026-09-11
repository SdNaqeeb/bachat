/**
 * Push notifications (spec §10).
 *
 * The collector sends FCM HTTP v1 directly, so this app never touches the Expo
 * push relay — it only has to do three things, and all three are required for a
 * notification to reach a *killed* app:
 *
 * 1. hold the Android 13+ `POST_NOTIFICATIONS` runtime permission;
 * 2. own a notification channel per category at `IMPORTANCE_HIGH`, so the user
 *    can mute "Snacks" at OS level without muting "Dairy";
 * 3. hand the raw **FCM device token** to the Worker — `getDevicePushTokenAsync`,
 *    not `getExpoPushTokenAsync`, which would need a `projectId` and route
 *    through Expo's relay.
 *
 * It also records the last push this device actually received, which is half of
 * the delivery-health readout Settings shows: OEM battery managers silently drop
 * FCM wake broadcasts, and the only honest response is to make the gap between
 * "sent" and "received" visible rather than mysterious.
 */

import * as Notifications from 'expo-notifications';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { usePrefs } from '@/hooks/use-prefs';
import { apiClient } from '@/lib/client';
import { messageForError } from '@/lib/api';
import type { Category } from '@/lib/types';
import { palette } from '@/theme';

/** Banners while the app is foregrounded — a price drop is worth interrupting for. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Channel every alert falls back to when its category has no channel yet. */
export const DEFAULT_CHANNEL_ID = 'deals';

export type NotificationPermission = 'unknown' | 'granted' | 'denied' | 'undetermined';

export type NotificationsContextValue = {
  permission: NotificationPermission;
  /** The FCM device token the Worker pushes to, once registered. */
  token: string | null;
  /** True while a permission request or registration is in flight. */
  busy: boolean;
  /** Last registration failure in user-facing prose, or null. */
  error: string | null;
  /**
   * Asks for permission (a no-op if already granted), then registers the device
   * token with the Worker. Resolves to whether push can now be delivered.
   * Safe to call repeatedly; the token is only re-sent when it changes.
   */
  enable: () => Promise<boolean>;
  /**
   * Creates one `IMPORTANCE_HIGH` Android channel per category. Call this once
   * the facets for a mode have loaded; it is idempotent.
   */
  ensureChannels: (categories: Category[]) => Promise<void>;
  /** Epoch ms of the last push this device received. Null if none yet (spec §10). */
  lastReceivedAt: number | null;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings } = usePrefs();
  const [permission, setPermission] = useState<NotificationPermission>('unknown');
  const [token, setToken] = useState<string | null>(settings.pushToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mirrored into a ref inside an effect so `enable` doesn't change identity on
  // every settings write — re-creating it would restart any screen effect that
  // depends on it.
  const storedToken = useRef(settings.pushToken);
  useEffect(() => {
    storedToken.current = settings.pushToken;
  }, [settings.pushToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await Notifications.getPermissionsAsync();
        if (cancelled) return;
        setPermission(
          status.granted ? 'granted' : status.canAskAgain ? 'undetermined' : 'denied'
        );
      } catch {
        if (!cancelled) setPermission('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The receiving half of the delivery-health readout (spec §10).
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(() => {
      updateSettings({ lastPushReceivedAt: Date.now() });
    });
    return () => subscription.remove();
  }, [updateSettings]);

  const ensureChannels = useCallback(async (categories: Category[]) => {
    if (Platform.OS !== 'android') return;
    try {
      await Notifications.setNotificationChannelAsync(DEFAULT_CHANNEL_ID, {
        name: 'Price drops',
        importance: Notifications.AndroidImportance.HIGH,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        lightColor: palette.save,
        vibrationPattern: [0, 180, 100, 180],
      });
      for (const category of categories) {
        await Notifications.setNotificationChannelAsync(category.id, {
          name: category.label,
          // Anything below HIGH is not allowed to wake a killed app.
          importance: Notifications.AndroidImportance.HIGH,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          lightColor: palette.save,
          vibrationPattern: [0, 180, 100, 180],
        });
      }
    } catch {
      // Channel creation failing is not worth blocking a screen over; the
      // default channel in app.json still delivers.
    }
  }, []);

  const enable = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      let status = await Notifications.getPermissionsAsync();
      if (!status.granted && status.canAskAgain) {
        status = await Notifications.requestPermissionsAsync();
      }
      if (!status.granted) {
        setPermission(status.canAskAgain ? 'undetermined' : 'denied');
        setError(
          'Bachat cannot send price alerts without notification permission. Turn it on in Android Settings > Apps > Bachat > Notifications.'
        );
        return false;
      }
      setPermission('granted');

      // The raw FCM token, not an Expo push token — the collector talks to FCM
      // HTTP v1 directly (spec §10).
      const device = await Notifications.getDevicePushTokenAsync();
      const nextToken = String(device.data);
      setToken(nextToken);

      if (nextToken !== storedToken.current) {
        await apiClient.registerDevice(
          nextToken,
          Platform.OS === 'ios' ? 'ios' : 'android'
        );
        updateSettings({ pushToken: nextToken });
      }
      return true;
    } catch (caught) {
      setError(messageForError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, [updateSettings]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      permission,
      token,
      busy,
      error,
      enable,
      ensureChannels,
      lastReceivedAt: settings.lastPushReceivedAt,
    }),
    [permission, token, busy, error, enable, ensureChannels, settings.lastPushReceivedAt]
  );

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error('useNotifications must be used inside a <NotificationsProvider>.');
  }
  return context;
}
