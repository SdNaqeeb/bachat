// Shared types for the Bachat Worker.
// Kept in one small file since the whole API surface is deliberately tiny.

export type Env = {
  DB: D1Database;
  INGEST_KEY: string;
};

export type Mode = "quick" | "fashion";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export type Retailer = {
  id: string;
  name: string;
  mode: Mode;
  deeplink_tpl: string;
};

export type Fees = {
  delivery: number;
  handling: number;
  eta_minutes: number | null;
};

export type PeriodLowClaim = {
  is_period_low: boolean;
  days_observed: number;
  low_price: number;
  claim: string; // e.g. "lowest in 12 days" — never claims 30 with <30 days observed
};
