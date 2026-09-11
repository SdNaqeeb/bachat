import { describe, expect, it } from "vitest";
import { computePeriodLow } from "../src/lib/history";

describe("computePeriodLow (30-day-low honesty rule)", () => {
  it("never claims a 30-day low when fewer than 30 days of history exist", () => {
    const twelveDays = Array.from({ length: 12 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, "0")}`,
      min_price: 30,
      max_price: 40,
    }));
    const result = computePeriodLow(twelveDays, 30, 30);
    expect(result.days_observed).toBe(12);
    expect(result.is_period_low).toBe(true);
    expect(result.claim).toBe("lowest in 12 days");
    expect(result.claim).not.toContain("30");
  });

  it("reports zero history honestly instead of a false low claim", () => {
    const result = computePeriodLow([], 30, 30);
    expect(result.days_observed).toBe(0);
    expect(result.is_period_low).toBe(false);
    expect(result.claim).toBe("no price history yet");
  });

  it("claims a full 30-day low only when 30 days actually exist", () => {
    const thirtyDays = Array.from({ length: 30 }, (_, i) => ({
      day: `d${i}`,
      min_price: 50,
      max_price: 60,
    }));
    const result = computePeriodLow(thirtyDays, 50, 30);
    expect(result.days_observed).toBe(30);
    expect(result.claim).toBe("lowest in 30 days");
  });

  it("does not claim a period low when the current price is above the window minimum", () => {
    const rows = [
      { day: "d1", min_price: 20, max_price: 25 },
      { day: "d2", min_price: 22, max_price: 26 },
    ];
    const result = computePeriodLow(rows, 24, 30);
    expect(result.is_period_low).toBe(false);
    expect(result.low_price).toBe(20);
    expect(result.claim).toContain("not a period low");
  });

  it("caps the claimed day count at the requested window even if more history exists", () => {
    const fortyDays = Array.from({ length: 40 }, (_, i) => ({
      day: `d${i}`,
      min_price: 10,
      max_price: 12,
    }));
    // caller is expected to only pass rows within the window, but the
    // function still defends against an oversized array by capping the claim
    const result = computePeriodLow(fortyDays, 10, 30);
    expect(result.claim).toBe("lowest in 30 days");
  });
});
