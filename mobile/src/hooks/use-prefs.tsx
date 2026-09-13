/**
 * Settings, in two halves that look like one to a screen.
 *
 * {@link Prefs} are shared with the server — the collector reads the threshold,
 * the enabled categories, the pincode and the quiet hours when it decides what
 * to sweep and what to push (spec §5, §7, §8). {@link LocalSettings} never
 * leave the phone.
 *
 * Both hydrate from AsyncStorage on mount and persist on change with a short
 * debounce, exposing `ready` so the root layout can hold the splash screen
 * rather than letting this provider block its children. Server prefs are
 * pushed with the same debounce and fail silently: a phone with no signal must
 * still be able to change a setting.
 */

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

import { apiClient } from '@/lib/client';
import {
  loadLocalSettings,
  loadPrefs,
  saveLocalSettings,
  savePrefs as persistPrefs,
} from '@/lib/storage';
import { hydratePrefs, shouldPush } from '@/lib/prefs-sync';
import {
  DEFAULT_LOCAL_SETTINGS,
  DEFAULT_PREFS,
  type LocalSettings,
  type Prefs,
  type RetailerFees,
} from '@/lib/types';

const PERSIST_DEBOUNCE_MS = 300;
/** The server is slower and less important than the local write, so it waits. */
const SYNC_DEBOUNCE_MS = 900;

export type PrefsContextValue = {
  prefs: Prefs;
  settings: LocalSettings;
  /** Shallow-merges server prefs, persists locally, and syncs to the Worker. */
  update: (partial: Partial<Prefs>) => void;
  /** Shallow-merges device-only settings. Never leaves the phone. */
  updateSettings: (partial: Partial<LocalSettings>) => void;
  /** Adds or removes a category slug from `enabledCategories`. */
  toggleCategory: (categoryId: string) => void;
  /** Sets one retailer's delivery/handling fees (spec §8). */
  setFees: (retailerId: string, fees: RetailerFees) => void;
  /** Restores every field to its shipped default. */
  reset: () => void;
  /** False until both stores have been read. Gates the splash screen. */
  ready: boolean;
  /**
   * The last failure while syncing prefs to the Worker, or null. Settings can
   * surface this; nothing else should care.
   */
  syncError: string | null;
};

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_LOCAL_SETTINGS);
  const [ready, setReady] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const hydrated = useRef(false);
  /** What this session started with, so an unchanged state is never pushed. */
  const hydratedPrefs = useRef<Prefs>(DEFAULT_PREFS);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedPrefs, storedSettings, serverPrefs] = await Promise.all([
        loadPrefs(),
        loadLocalSettings(),
        // Offline is normal here, not an error. `hydratePrefs` falls back to
        // the local copy when this resolves null.
        apiClient.prefs().catch(() => null),
      ]);
      if (cancelled) return;
      const merged = hydratePrefs(storedPrefs, serverPrefs);
      hydratedPrefs.current = merged;
      setPrefs(merged);
      setSettings(storedSettings);
      // Set only once the server's copy is known. This flag gates the sync
      // effect below, and flipping it after the local read alone is what let a
      // phone holding `enabledCategories: []` erase the server's list — which
      // left the collector with nothing to sweep for a day.
      hydrated.current = true;
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist after hydration only, so the defaults never overwrite real data.
  useEffect(() => {
    if (!hydrated.current) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      void persistPrefs(prefs);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [prefs]);

  useEffect(() => {
    if (!hydrated.current) return;
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      void saveLocalSettings(settings);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
    };
  }, [settings]);

  useEffect(() => {
    if (!hydrated.current) return;
    // Nothing changed since hydration, so there is nothing to write. Without
    // this, merely opening the app posts the server's own values back to it.
    if (!shouldPush(hydratedPrefs.current, prefs)) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      apiClient
        .savePrefs(prefs)
        .then(() => {
          hydratedPrefs.current = prefs;
          setSyncError(null);
        })
        // Offline is a normal state for this app, not an error worth a dialog.
        .catch((error: unknown) =>
          setSyncError(error instanceof Error ? error.message : 'Settings not synced yet.')
        );
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [prefs]);

  const update = useCallback((partial: Partial<Prefs>) => {
    setPrefs((previous) => ({ ...previous, ...partial }));
  }, []);

  const updateSettings = useCallback((partial: Partial<LocalSettings>) => {
    setSettings((previous) => ({ ...previous, ...partial }));
  }, []);

  const toggleCategory = useCallback((categoryId: string) => {
    setPrefs((previous) => {
      const enabled = previous.enabledCategories.includes(categoryId);
      return {
        ...previous,
        enabledCategories: enabled
          ? previous.enabledCategories.filter((entry) => entry !== categoryId)
          : [...previous.enabledCategories, categoryId],
      };
    });
  }, []);

  const setFees = useCallback((retailerId: string, fees: RetailerFees) => {
    setPrefs((previous) => ({
      ...previous,
      fees: { ...previous.fees, [retailerId]: fees },
    }));
  }, []);

  const reset = useCallback(() => {
    setPrefs({ ...DEFAULT_PREFS });
    setSettings({ ...DEFAULT_LOCAL_SETTINGS });
  }, []);

  const value = useMemo<PrefsContextValue>(
    () => ({
      prefs,
      settings,
      update,
      updateSettings,
      toggleCategory,
      setFees,
      reset,
      ready,
      syncError,
    }),
    [prefs, settings, update, updateSettings, toggleCategory, setFees, reset, ready, syncError]
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const context = useContext(PrefsContext);
  if (!context) {
    throw new Error('usePrefs must be used inside a <PrefsProvider>.');
  }
  return context;
}
