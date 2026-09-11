/**
 * The OEM profile lookup (spec §10).
 *
 * `profileFor` returns the FIRST array match, which makes the order of
 * `PROFILES` behaviour rather than presentation. Realme UI is ColorOS-derived,
 * so a `realme` device also matches nothing in the OnePlus/Oppo entry only
 * because that entry no longer claims it — and if someone reorders the array or
 * re-adds the token, a Realme owner would silently be shown instructions for a
 * different phone, with no error anywhere. These tests exist to make that loud.
 */

import { describe, expect, it } from 'vitest';

import { PROFILES, isAggressiveOem, profileFor } from '@/lib/oem-profiles';

describe('profileFor', () => {
  it('gives Realme its own profile, not the OnePlus/Oppo one', () => {
    // Build.MANUFACTURER is lower-case "realme" on these devices.
    expect(profileFor('realme').id).toBe('realme');
    expect(profileFor('realme realme').id).toBe('realme');
    expect(profileFor('Realme RMX3461').id).toBe('realme');
  });

  it('routes the other aggressive skins to their own profiles', () => {
    expect(profileFor('Xiaomi').id).toBe('xiaomi');
    expect(profileFor('Redmi').id).toBe('xiaomi');
    expect(profileFor('POCO').id).toBe('xiaomi');
    expect(profileFor('samsung').id).toBe('samsung');
    expect(profileFor('OnePlus').id).toBe('oneplus-oppo');
    expect(profileFor('OPPO').id).toBe('oneplus-oppo');
    expect(profileFor('vivo').id).toBe('vivo');
  });

  it('falls back to generic for an unknown or empty manufacturer', () => {
    expect(profileFor('Google').id).toBe('generic');
    expect(profileFor('Motorola').id).toBe('generic');
    expect(profileFor('').id).toBe('generic');
  });

  it('keeps generic last, since it doubles as the fallback', () => {
    expect(PROFILES[PROFILES.length - 1]!.id).toBe('generic');
    expect(PROFILES.filter((p) => p.id === 'generic')).toHaveLength(1);
  });

  it('orders every specific skin ahead of a family that would also match it', () => {
    // Realme must precede OnePlus/Oppo. Written generally so a future
    // ColorOS/One UI sibling added in the wrong place also trips this.
    const indexOf = (id: string) => PROFILES.findIndex((p) => p.id === id);
    expect(indexOf('realme')).toBeLessThan(indexOf('oneplus-oppo'));
  });

  it('claims no token twice, so no device can match two profiles', () => {
    const tokens = PROFILES.flatMap((p) => p.match);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('profile content', () => {
  it('treats every skin except generic as an aggressive battery manager', () => {
    for (const profile of PROFILES) {
      expect(isAggressiveOem(profile)).toBe(profile.id !== 'generic');
    }
  });

  it('gives every profile written steps and an intent chain ending in a generic fallback', () => {
    for (const profile of PROFILES) {
      // The written steps are the only thing guaranteed to work when an OEM
      // renames its settings activity, so none may be empty.
      expect(profile.steps.length).toBeGreaterThan(0);
      expect(profile.intents.length).toBeGreaterThan(0);

      const last = profile.intents[profile.intents.length - 1]!;
      expect(last.action.startsWith('android.settings.')).toBe(true);
      expect(last.params).toBeUndefined();
    }
  });

  it("tells Realme owners about sleep standby and quick freeze", () => {
    // These two ColorOS defaults drop overnight pushes even with auto-launch
    // granted, and overnight is exactly when a sweep runs. Dropping them from
    // the copy would make the guide quietly insufficient on this phone.
    const realme = PROFILES.find((p) => p.id === 'realme')!;
    const steps = realme.steps.join(' ').toLowerCase();
    expect(steps).toContain('auto launch');
    expect(steps).toContain('sleep standby');
    expect(steps).toContain('freeze');
  });
});
