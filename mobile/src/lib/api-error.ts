/**
 * The single error type the whole app rejects with.
 *
 * It lives in its own module so `./decode.ts` (which raises `parse` failures)
 * and `./api.ts` (which raises transport failures and calls the decoders) can
 * both use it without importing each other. Both modules re-export it, so
 * `import { ApiError } from '@/lib/api'` keeps working unchanged.
 */

export type ApiErrorKind =
  | 'timeout'
  | 'network'
  | 'server'
  | 'unavailable'
  | 'parse';

/**
 * `message` is always user-facing prose — never a stack trace or a raw fetch
 * message. Anything technical goes in `cause`, which is for logs only.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** Raw underlying failure, kept for logging only. Never shown to the user. */
  readonly cause?: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options?.status;
    this.cause = options?.cause;
    // Required so `instanceof ApiError` survives the ES5 class downlevel that
    // Metro/Hermes still applies to some dependency graphs.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
