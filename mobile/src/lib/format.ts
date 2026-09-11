/**
 * Display formatting. Every rupee amount and every timestamp in the UI goes
 * through here, so the app speaks with one voice and rounding happens once.
 *
 * Indian conventions on purpose: the rupee sign sits tight against the digits
 * (`₹612`), thousands group 2-2-3 (`₹1,24,500`), and paise are dropped unless
 * the amount genuinely has them — a grocery list of `₹45.00` reads as noise.
 */

/** `612` -> `₹612`. `1245.5` -> `₹1,245.50`. `124500` -> `₹1,24,500`. */
export function rupees(amount: number, options?: { paise?: boolean }): string {
  if (!Number.isFinite(amount)) return '—';
  const showPaise = options?.paise ?? Math.abs(amount % 1) > 0.005;
  const fixed = Math.abs(amount).toFixed(showPaise ? 2 : 0);
  const [whole, fraction] = fixed.split('.');
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${groupIndian(whole ?? '0')}${fraction ? `.${fraction}` : ''}`;
}

/** 2-2-3 digit grouping: the last three digits, then pairs. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** `0.42` -> `42% off`. Rounds down so the app never overstates a discount. */
export function discountLabel(fraction: number | null): string | null {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return null;
  return `${Math.floor(fraction * 100)}% off`;
}

/** `{ price, mrp }` -> `0.42`, or null when there is no genuine markdown. */
export function discountFraction(price: number, mrp: number | null): number | null {
  if (mrp === null || mrp <= 0 || price >= mrp) return null;
  return (mrp - price) / mrp;
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How old a price is, in words. Spec §9 makes this non-optional: every price
 * on screen carries its age, so this string has to be short enough to sit in a
 * chip and honest enough to be trusted.
 *
 * `now` is injectable so tests don't depend on the clock.
 */
export function ageLabel(capturedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return 'age unknown';
  const elapsed = Math.max(0, now - capturedAt);
  if (elapsed < 2 * MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.round(elapsed / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.round(elapsed / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** How worried to look about a price this old. Drives the staleness chip's colour. */
export type Freshness = 'fresh' | 'ageing' | 'stale';

/**
 * Quick-commerce prices move within hours; fashion moves over days. The
 * thresholds differ by mode so a 6-hour-old kurta isn't flagged as a problem.
 */
export function freshnessOf(
  capturedAt: number,
  mode: 'quick' | 'fashion',
  now: number = Date.now()
): Freshness {
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return 'stale';
  const elapsed = Math.max(0, now - capturedAt);
  // The quick sweep runs every 4 h and the fashion sweep twice a day (spec §12);
  // one missed sweep is "ageing", two is "stale".
  const window = mode === 'quick' ? 4 * HOUR : 12 * HOUR;
  if (elapsed <= window * 1.25) return 'fresh';
  if (elapsed <= window * 2.5) return 'ageing';
  return 'stale';
}

/**
 * The honesty rule (spec §7): never claim a 30-day low we can't substantiate.
 * Returns null when there isn't enough history to claim anything at all.
 */
export function periodLowLabel(historyDays: number): string | null {
  if (!Number.isFinite(historyDays) || historyDays < 2) return null;
  const days = Math.floor(historyDays);
  return days >= 30 ? 'Lowest in 30 days' : `Lowest in ${days} days`;
}

/** `90` -> `1 hr 30 min`. Used for a retailer's delivery estimate. */
export function etaLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** `6` of `7` -> `6/7 in stock`. */
export function stockLabel(inStockCount: number, itemCount: number): string {
  return `${inStockCount}/${itemCount} in stock`;
}
