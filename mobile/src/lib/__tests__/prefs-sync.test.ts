/**
 * The phone must not silently overwrite the server's prefs.
 *
 * What happened: `PrefsProvider` hydrated from AsyncStorage only, flipped
 * `hydrated` true, and then pushed its entire local state to the Worker. There
 * was no `GET /api/prefs` anywhere in that path, so the phone was authoritative
 * over a server it never read. A phone holding `enabledCategories: []` wrote
 * that over a server list of twelve slugs, and the collector — which reads
 * `enabled_categories` to decide what to sweep — then had nothing to sweep.
 * Quick commerce collected zero products for a day because of it.
 *
 * `hydratePrefs` is the decision that fixes it, kept pure so it can be tested
 * without a React harness (this project has vitest but no jsdom or testing
 * library, and `decode.ts` sets the precedent of putting logic in pure
 * functions).
 */

import { describe, expect, it } from 'vitest';

import { hydratePrefs, shouldPush } from '@/lib/prefs-sync';
import { DEFAULT_PREFS, type Prefs } from '@/lib/types';

const LOCAL_EMPTY: Prefs = { ...DEFAULT_PREFS };

const SERVER_REAL: Prefs = {
  ...DEFAULT_PREFS,
  threshold: 0.7,
  enabledCategories: ['staples', 'dairy', 'snacks'],
  pincode: '500016',
  lat: 17.4435,
  lon: 78.4645,
};

const LOCAL_STALE: Prefs = {
  ...DEFAULT_PREFS,
  threshold: 0.2,
  enabledCategories: ['snacks'],
  pincode: '500016',
};

describe('hydratePrefs', () => {
  it('keeps the server list when the phone has none — the exact regression', () => {
    const out = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);

    expect(out.enabledCategories).toEqual(['staples', 'dairy', 'snacks']);
    expect(out.threshold).toBe(0.7);
    expect(out.lat).toBe(17.4435);
  });

  it('prefers the server over a stale local copy', () => {
    const out = hydratePrefs(LOCAL_STALE, SERVER_REAL);

    expect(out.enabledCategories).toEqual(SERVER_REAL.enabledCategories);
    expect(out.threshold).toBe(0.7);
  });

  it('falls back to local when the server could not be reached', () => {
    // Offline is a normal state for this app, not an error. A phone with no
    // signal must still open with the settings it had.
    const out = hydratePrefs(LOCAL_STALE, null);

    expect(out).toEqual(LOCAL_STALE);
  });

  it('returns the defaults when both sides are empty', () => {
    expect(hydratePrefs(LOCAL_EMPTY, null)).toEqual(DEFAULT_PREFS);
  });

  it('does not mutate either input', () => {
    const local = { ...LOCAL_STALE };
    const server = { ...SERVER_REAL };
    hydratePrefs(local, server);

    expect(local).toEqual(LOCAL_STALE);
    expect(server).toEqual(SERVER_REAL);
  });
});

describe('shouldPush', () => {
  it('is false immediately after hydration, so opening the app writes nothing', () => {
    const hydrated = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);

    expect(shouldPush(hydrated, hydrated)).toBe(false);
  });

  it('is false for an equal-but-not-identical object', () => {
    const hydrated = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);

    expect(shouldPush(hydrated, { ...hydrated })).toBe(false);
  });

  it('is true once the user actually changes something', () => {
    const hydrated = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);
    const edited: Prefs = { ...hydrated, threshold: 0.5 };

    expect(shouldPush(hydrated, edited)).toBe(true);
  });

  it('is true when a category is toggled off', () => {
    const hydrated = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);
    const edited: Prefs = { ...hydrated, enabledCategories: ['staples', 'dairy'] };

    expect(shouldPush(hydrated, edited)).toBe(true);
  });

  it('ignores category order, which is not a user-visible change', () => {
    const hydrated = hydratePrefs(LOCAL_EMPTY, SERVER_REAL);
    const reordered: Prefs = {
      ...hydrated,
      enabledCategories: ['snacks', 'staples', 'dairy'],
    };

    expect(shouldPush(hydrated, reordered)).toBe(false);
  });
});
