/**
 * Loads the wire fixtures captured from the real Worker.
 *
 * These files are written by `worker/test/contract.test.ts`, which serves a
 * real request through the Worker's real Hono app against the real
 * `worker/schema.sql`. Nothing here is hand-authored: if you find yourself
 * wanting to edit a file under `fixtures/wire/`, the thing to change is the
 * Worker, and then `cd worker && npm test` to re-capture.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const WIRE_DIR = path.join(process.cwd(), 'src', 'lib', '__tests__', 'fixtures', 'wire');

export type WireFixture =
  | 'health'
  | 'basket-quick'
  | 'basket-replace'
  | 'deals-quick'
  | 'compare-quick'
  | 'compare-fashion'
  | 'history-partial'
  | 'history-empty'
  | 'history-full'
  | 'facets-quick'
  | 'facets-fashion'
  | 'prefs'
  | 'error-404';

/** The Worker's real response body for `name`, parsed. */
export function wire(name: WireFixture): unknown {
  const file = path.join(WIRE_DIR, `${name}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Missing wire fixture '${name}'. Regenerate with \`cd worker && npm test\`. (${String(error)})`
    );
  }
}

/** A deep clone, so a test can corrupt one field without leaking to the next. */
export function wireCopy(name: WireFixture): any {
  return JSON.parse(JSON.stringify(wire(name)));
}

/**
 * Walks a decoded value looking for the failure modes that put a wrong number
 * on screen: NaN, Infinity, and `undefined` where a value was expected.
 */
export function findNumericRot(value: unknown, at = '$'): string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${at} = ${value}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) => findNumericRot(entry, `${at}[${i}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      findNumericRot(entry, `${at}.${key}`)
    );
  }
  return [];
}
