/**
 * Reconciling the phone's prefs with the Worker's.
 *
 * {@link Prefs} are shared: the collector reads `enabled_categories`, the
 * threshold, the pincode and the quiet hours to decide what to sweep and what
 * to push. The phone used to be authoritative over them — it hydrated from
 * AsyncStorage, never read the server, and then wrote its whole local state
 * up. A phone holding `enabledCategories: []` therefore erased a server list
 * of twelve slugs, and the collector had nothing left to sweep.
 *
 * The decision lives here as pure functions rather than inside the provider so
 * it can be tested without a React harness, the same way `decode.ts` keeps
 * parsing testable without a network.
 */

import type { Prefs } from '@/lib/types';

/**
 * The prefs to start the session with.
 *
 * The server wins when it answered. It is the only copy the collector reads and
 * the only one shared across devices; the phone's copy is a cache of it. There
 * are no timestamps on either side, so no principled last-write-wins is
 * available, and the asymmetry settles it: losing a local toggle costs one tap,
 * while losing the server's category list silently stops collection until
 * somebody notices — which is exactly what happened.
 *
 * `null` means the Worker could not be reached. Offline is a normal state for
 * this app, not an error, so the local copy is used unchanged.
 *
 * The known cost: a change made offline is overwritten by the server's copy on
 * the next online launch. Surviving that needs a dirty flag and a real merge,
 * which is not built because nothing yet needs it.
 */
export function hydratePrefs(local: Prefs, server: Prefs | null): Prefs {
  if (server === null) return { ...local };
  return { ...server };
}

/**
 * Whether the current prefs differ from what the session hydrated with.
 *
 * Without this the provider posts the server's own values straight back to it
 * the moment the app opens — a pointless write, and one that would re-introduce
 * the clobbering risk on any field the round trip does not preserve exactly.
 *
 * Category order is ignored: `enabledCategories` is a set in everything but
 * type, and the pickers can reorder it without the user changing anything.
 */
export function shouldPush(hydrated: Prefs, current: Prefs): boolean {
  return !prefsEqual(hydrated, current);
}

function prefsEqual(a: Prefs, b: Prefs): boolean {
  return (
    a.threshold === b.threshold &&
    a.pincode === b.pincode &&
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.notificationsEnabled === b.notificationsEnabled &&
    a.quietHours.start === b.quietHours.start &&
    a.quietHours.end === b.quietHours.end &&
    sameSet(a.enabledCategories, b.enabledCategories) &&
    sameFees(a.fees, b.fees)
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, i) => value === sortedB[i]);
}

function sameFees(a: Prefs['fees'], b: Prefs['fees']): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => {
    const feeA = a[key];
    const feeB = b[key];
    if (feeA === undefined || feeB === undefined) return false;
    return feeA.deliveryFee === feeB.deliveryFee && feeA.handlingFee === feeB.handlingFee;
  });
}
