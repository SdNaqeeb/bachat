/**
 * Typed, crash-proof wrapper over AsyncStorage.
 *
 * Every read is total: a corrupt blob, a shape from an older release, or a
 * storage backend that simply fails returns the default value. Nothing in here
 * throws, because a failed persist must never be able to break the UI.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_LOCAL_SETTINGS,
  DEFAULT_MODE,
  DEFAULT_PREFS,
  type LocalSettings,
  type Mode,
  type Prefs,
} from '@/lib/types';

export const STORAGE_KEYS = {
  mode: 'bachat:mode',
  prefs: 'bachat:prefs',
  settings: 'bachat:settings',
} as const;

async function readJson(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw.length === 0) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is best-effort. See the module doc block.
  }
}

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

export async function loadMode(): Promise<Mode> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.mode);
    return raw === 'quick' || raw === 'fashion' ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export async function saveMode(mode: Mode): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.mode, mode);
  } catch {
    // Ignored — see writeJson.
  }
}

/* ------------------------------------------------------------------ */
/* Prefs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Merges the stored blob over {@link DEFAULT_PREFS} field by field, so a pref
 * added in a later release doesn't break an existing install and a wrong-typed
 * field falls back rather than poisoning the app.
 */
export function coercePrefs(value: unknown): Prefs {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PREFS };
  const record = value as Record<string, unknown>;

  const quiet =
    typeof record.quietHours === 'object' && record.quietHours !== null
      ? (record.quietHours as Record<string, unknown>)
      : {};

  return {
    threshold: clampFraction(record.threshold, DEFAULT_PREFS.threshold),
    enabledCategories: Array.isArray(record.enabledCategories)
      ? record.enabledCategories.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0
        )
      : [...DEFAULT_PREFS.enabledCategories],
    quietHours: {
      start: clampHour(quiet.start, DEFAULT_PREFS.quietHours.start),
      end: clampHour(quiet.end, DEFAULT_PREFS.quietHours.end),
    },
    pincode: typeof record.pincode === 'string' ? record.pincode : DEFAULT_PREFS.pincode,
    lat: finiteOrNull(record.lat),
    lon: finiteOrNull(record.lon),
    fees: coerceFees(record.fees),
    notificationsEnabled:
      typeof record.notificationsEnabled === 'boolean'
        ? record.notificationsEnabled
        : DEFAULT_PREFS.notificationsEnabled,
  };
}

function coerceFees(value: unknown): Prefs['fees'] {
  if (typeof value !== 'object' || value === null) return {};
  const out: Prefs['fees'] = {};
  for (const [retailerId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fee = entry as Record<string, unknown>;
    out[retailerId] = {
      deliveryFee: Math.max(0, finiteOrNull(fee.deliveryFee) ?? 0),
      handlingFee: Math.max(0, finiteOrNull(fee.handlingFee) ?? 0),
    };
  }
  return out;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampFraction(value: unknown, fallback: number): number {
  const parsed = finiteOrNull(value);
  if (parsed === null) return fallback;
  return Math.min(0.95, Math.max(0.05, parsed));
}

function clampHour(value: unknown, fallback: number): number {
  const parsed = finiteOrNull(value);
  if (parsed === null) return fallback;
  return Math.min(23, Math.max(0, Math.round(parsed)));
}

export async function loadPrefs(): Promise<Prefs> {
  return coercePrefs(await readJson(STORAGE_KEYS.prefs));
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await writeJson(STORAGE_KEYS.prefs, prefs);
}

/* ------------------------------------------------------------------ */
/* Local settings                                                      */
/* ------------------------------------------------------------------ */

export function coerceLocalSettings(value: unknown): LocalSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_LOCAL_SETTINGS };
  const record = value as Record<string, unknown>;

  return {
    haptics:
      typeof record.haptics === 'boolean'
        ? record.haptics
        : DEFAULT_LOCAL_SETTINGS.haptics,
    pushToken: typeof record.pushToken === 'string' ? record.pushToken : null,
    lastPushReceivedAt: finiteOrNull(record.lastPushReceivedAt),
    batteryGuideDone:
      typeof record.batteryGuideDone === 'boolean' ? record.batteryGuideDone : false,
  };
}

export async function loadLocalSettings(): Promise<LocalSettings> {
  return coerceLocalSettings(await readJson(STORAGE_KEYS.settings));
}

export async function saveLocalSettings(settings: LocalSettings): Promise<void> {
  await writeJson(STORAGE_KEYS.settings, settings);
}
