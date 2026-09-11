/**
 * Haptics, centralised so one settings toggle silences the whole app and a
 * device without a vibrator never throws.
 *
 * `expo-haptics` rejects on hardware that cannot vibrate; every call here is
 * fire-and-forget for that reason.
 */

import * as Haptics from 'expo-haptics';
import { useMemo } from 'react';

export type HapticsApi = {
  /** A tap on any surface. */
  tap: () => void;
  /** A discrete choice: a tab, a filter chip, a mode flip. */
  selection: () => void;
  /** A result landed — the basket comparison resolved, a deal was saved. */
  success: () => void;
  /** Something failed in a way the user has to notice. */
  warning: () => void;
};

const NOOP: HapticsApi = {
  tap: () => {},
  selection: () => {},
  success: () => {},
  warning: () => {},
};

export function useHaptics(enabled: boolean = true): HapticsApi {
  return useMemo<HapticsApi>(() => {
    if (!enabled) return NOOP;
    return {
      tap: () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      },
      selection: () => {
        void Haptics.selectionAsync().catch(() => {});
      },
      success: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => {}
        );
      },
      warning: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
          () => {}
        );
      },
    };
  }, [enabled]);
}
