// Date helpers. All "day" strings are ISO calendar dates (UTC), matching
// price_daily.day. captured_at is stored as epoch milliseconds throughout.

export function dayString(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return iso.slice(0, 10); // 'YYYY-MM-DD'
}

export function daysAgoString(days: number, from: number = Date.now()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return dayString(d.getTime());
}

export function ageSeconds(capturedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - capturedAt) / 1000));
}
