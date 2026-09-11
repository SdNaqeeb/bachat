/**
 * The OEM battery-manager profile table (spec §10).
 *
 * Pure data and two pure lookups, deliberately kept out of the component so
 * they can be tested: vitest covers `src/lib` only, because that is the code
 * with no React Native or native-module imports. The two generic actions below
 * are the literal string values of expo-intent-launcher's `ActivityAction`
 * constants, inlined for the same reason.
 *
 * ORDER IS BEHAVIOUR. `profileFor` returns the FIRST match, so a more specific
 * skin must precede the family it belongs to - Realme before OnePlus/Oppo -
 * and `generic` must stay last, since it doubles as the fallback. Tests pin
 * both, because reordering the array silently sends a user to instructions for
 * the wrong phone.
 */

/**
 * A structural subset of expo-intent-launcher's `IntentLauncherParams`, so this
 * module stays free of native imports. Keep it assignable to that type: the
 * component spreads these straight into `startActivityAsync`.
 */
export type IntentParams = {
  packageName?: string;
  className?: string;
  category?: string;
  /** Used by the app-details fallback, as `package:<id>`. */
  data?: string;
};

export type IntentAttempt = {
  action: string;
  params?: IntentParams;
};

export type OemProfile = {
  id: string;
  /** What the user calls their phone's skin, not the manufacturer's legal name. */
  label: string;
  /** Matched against the lower-cased manufacturer and brand. */
  match: string[];
  /** What to tap, in the order the OEM's own menus present it. */
  steps: string[];
  /** Tried in order; the first that resolves wins. */
  intents: IntentAttempt[];
};

/** Android's own screens, tried after any OEM-specific activity fails. */
const GENERIC_INTENTS: IntentAttempt[] = [
  { action: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS' },
  { action: 'android.settings.BATTERY_SAVER_SETTINGS' },
];

export const PROFILES: OemProfile[] = [
  {
    id: 'xiaomi',
    label: 'Xiaomi, Redmi or Poco (MIUI / HyperOS)',
    match: ['xiaomi', 'redmi', 'poco'],
    steps: [
      'Open Security, then Permissions, then Autostart, and switch Bachat on.',
      'Go back to Security, open Battery & performance, then App battery saver.',
      'Find Bachat and set it to No restrictions.',
      'In Settings > Apps > Bachat, turn off Battery optimisation.',
    ],
    intents: [
      {
        action: 'miui.intent.action.OP_AUTO_START',
        params: {
          packageName: 'com.miui.securitycenter',
          className: 'com.miui.permcenter.autostart.AutoStartManagementActivity',
          category: 'android.intent.category.DEFAULT',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.miui.securitycenter',
          className: 'com.miui.permcenter.autostart.AutoStartManagementActivity',
        },
      },
      ...GENERIC_INTENTS,
    ],
  },
  {
    id: 'samsung',
    label: 'Samsung (One UI)',
    match: ['samsung'],
    steps: [
      'Open Device care, then Battery, then Background usage limits.',
      'Make sure Bachat is not in Sleeping apps or Deep sleeping apps.',
      'Add Bachat to Never sleeping apps.',
      'In Settings > Apps > Bachat > Battery, choose Unrestricted.',
    ],
    intents: [
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.samsung.android.lool',
          className: 'com.samsung.android.sm.ui.battery.BatteryActivity',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.samsung.android.lool',
          className: 'com.samsung.android.sm.battery.ui.BatteryActivity',
        },
      },
      ...GENERIC_INTENTS,
    ],
  },
  {
    // Realme UI is ColorOS-derived but diverges enough to need its own entry.
    // Two of its defaults kill notifications and have no equivalent on
    // OxygenOS: "Sleep standby optimisation", which suspends background apps
    // once the screen has been off a while, and "App quick freeze". Auto-launch
    // alone is not enough here — with those two left on, a killed app still
    // misses pushes overnight, which is exactly when a sweep runs.
    //
    // The startup activity moved from com.coloros.safecenter to com.oplus.* in
    // Realme UI 3.0, and both names are still in the wild across versions, so
    // the chain tries the new one first and keeps the old as a fallback. The
    // written steps are the reliable path if every intent fails.
    id: 'realme',
    label: 'Realme (Realme UI)',
    match: ['realme'],
    steps: [
      'Open Settings, then Apps, then App management, and find Bachat.',
      'Turn on Allow auto launch.',
      'Go back to Settings, then Battery, and turn off Sleep standby optimisation.',
      'Still in Battery, open App battery management, find Bachat, and turn off Quick freeze — then allow background running.',
      'In Settings > Apps > Bachat > Battery usage, choose Don’t optimise or Unrestricted.',
      'In Recent apps, pull Bachat down (or long-press it) and lock it so it is not swiped away.',
    ],
    intents: [
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.oplus.safecenter',
          className: 'com.oplus.safecenter.startupapp.StartupAppListActivity',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.coloros.safecenter',
          className: 'com.coloros.safecenter.startupapp.StartupAppListActivity',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.coloros.safecenter',
          className: 'com.coloros.safecenter.startupmanager.StartupAppListActivity',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: { packageName: 'com.coloros.phonemanager' },
      },
      ...GENERIC_INTENTS,
    ],
  },
  {
    id: 'oneplus-oppo',
    label: 'OnePlus or Oppo (OxygenOS / ColorOS)',
    match: ['oneplus', 'oppo'],
    steps: [
      'Open Settings, then Battery, then More settings (or Battery optimisation).',
      'Turn on Allow auto-launch for Bachat.',
      'Set Bachat to Don’t optimise, or Allow background activity.',
      'In Recent apps, long-press Bachat and lock it so it is not swiped away.',
    ],
    intents: [
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.coloros.safecenter',
          className: 'com.coloros.safecenter.startupapp.StartupAppListActivity',
        },
      },
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.oppo.safe',
          className: 'com.oppo.safe.permission.startup.StartupAppListActivity',
        },
      },
      ...GENERIC_INTENTS,
    ],
  },
  {
    id: 'vivo',
    label: 'Vivo (Funtouch OS)',
    match: ['vivo', 'iqoo'],
    steps: [
      'Open i Manager, then App manager, then Autostart manager.',
      'Switch Bachat on.',
      'In Settings > Battery > High background power consumption, allow Bachat.',
    ],
    intents: [
      {
        action: 'android.intent.action.MAIN',
        params: {
          packageName: 'com.vivo.permissionmanager',
          className: 'com.vivo.permissionmanager.activity.BgStartUpManagerActivity',
        },
      },
      ...GENERIC_INTENTS,
    ],
  },
  {
    id: 'generic',
    label: 'Android',
    match: [],
    steps: [
      'Open Settings, then Apps, then Bachat.',
      'Open Battery and choose Unrestricted.',
      'Confirm notifications are allowed for Bachat.',
    ],
    intents: GENERIC_INTENTS,
  },
];

export function profileFor(manufacturer: string): OemProfile {
  const needle = manufacturer.toLowerCase();
  return (
    PROFILES.find((profile) => profile.match.some((token) => needle.includes(token))) ??
    PROFILES[PROFILES.length - 1]!
  );
}

/** True for the skins known to drop FCM wake broadcasts (spec §10). */
export function isAggressiveOem(profile: OemProfile): boolean {
  return profile.id !== 'generic';
}
