/**
 * The global mode (spec §9): Quick Commerce or Fashion.
 *
 * Mode gates which retailers, categories, deal feed and alerts apply, so it
 * lives above every screen rather than inside one. It also carries the accent
 * colour, because mode identity in Bachat *is* a hue (see src/theme/tokens.ts)
 * — read `accent` from here instead of branching on `mode` in a component.
 *
 * Hydrates from AsyncStorage and exposes `ready` so the root layout can hold
 * the splash screen rather than flashing the wrong mode's colour for a frame.
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

import { loadMode, saveMode } from '@/lib/storage';
import { DEFAULT_MODE, MODE_LABEL, type Mode } from '@/lib/types';
import { palette } from '@/theme';

export type ModeAccent = {
  accent: string;
  wash: string;
  hairline: string;
};

export type ModeContextValue = {
  mode: Mode;
  /** Human label for the current mode: 'Quick Commerce' / 'Fashion'. */
  label: string;
  /** The current mode's accent, wash and hairline. */
  accent: ModeAccent;
  setMode: (mode: Mode) => void;
  /** What the header switch calls. */
  toggle: () => void;
  /** False until the stored mode has been read. */
  ready: boolean;
};

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadMode();
      if (cancelled) return;
      setModeState(stored);
      hydrated.current = true;
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    // Not debounced: a mode flip is deliberate, rare, and must survive a kill
    // immediately afterwards.
    if (hydrated.current) void saveMode(next);
  }, []);

  const toggle = useCallback(() => {
    setModeState((previous) => {
      const next: Mode = previous === 'quick' ? 'fashion' : 'quick';
      if (hydrated.current) void saveMode(next);
      return next;
    });
  }, []);

  const value = useMemo<ModeContextValue>(
    () => ({
      mode,
      label: MODE_LABEL[mode],
      accent: palette.mode[mode],
      setMode,
      toggle,
      ready,
    }),
    [mode, setMode, toggle, ready]
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error('useMode must be used inside a <ModeProvider>.');
  }
  return context;
}
