// Small D1 query helpers shared across routes. Kept deliberately thin —
// each route owns its own SQL so it's easy to see exactly what runs.

import type { Env, Retailer } from "../types";

export async function getRetailers(env: Env): Promise<Retailer[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, mode, deeplink_tpl FROM retailers ORDER BY id",
  ).all<Retailer>();
  return results ?? [];
}

export async function getPref(env: Env, key: string): Promise<unknown | null> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function getFees(env: Env, retailerId: string): Promise<{
  delivery: number;
  handling: number;
  eta_minutes: number | null;
}> {
  const fees = (await getPref(env, `fees.${retailerId}`)) as
    | { delivery: number; handling: number; eta_minutes: number | null }
    | null;
  return fees ?? { delivery: 0, handling: 0, eta_minutes: null };
}

/** Builds `?,?,?` placeholders for an IN clause of the given length. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Splits a list into fixed-size chunks. Used to keep any single prepared
 * statement inside D1's 100-bound-parameter ceiling. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
