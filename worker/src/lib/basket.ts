// Basket comparison ranking — spec section 8. This is the single most
// important computation in the product, so it is a pure, isolated, and
// heavily tested module with zero D1 access.
//
// Rules enforced here (verbatim from the spec):
//   1. Rank by BASKET TOTAL (item subtotal + delivery + handling), never by
//      item price alone.
//   2. Only fully-stocked retailers may win outright. A retailer missing one
//      or more items is returned with its gap stated explicitly — it is
//      never silently ranked as if the basket were complete for it.
//   3. The winner's stated saving is against the RUNNER-UP (the next best
//      fully-stocked option), never against the worst option.

import type { Fees } from "../types";

export type BasketItemInput = {
  basket_item_id: string;
  label: string;
  qty: number;
};

/** One matched-and-priced line for a given retailer. Absent entirely means
 * "this retailer has no match for this basket item at all". */
export type RetailerLineInput = {
  basket_item_id: string;
  product_id: string;
  name: string;
  price: number;
  mrp: number | null;
  in_stock: boolean;
  captured_at: number;
  // Product detail carried through so the app can render and DEEP-LINK a
  // basket line (spec section 9) without a second round trip per product.
  // Optional so the pure ranking tests can stay minimal.
  retailer_id?: string;
  brand?: string | null;
  size?: string | null;
  pack?: string | null;
  image_url?: string | null;
  url?: string | null;
  category?: string | null;
  mode?: string | null;
  deeplink?: string | null;
};

export type RetailerBasketInput = {
  retailer_id: string;
  retailer_name: string;
  fees: Fees;
  lines: RetailerLineInput[];
};

export type PricedLine =
  | ({ status: "priced" } & RetailerLineInput)
  | { status: "missing"; basket_item_id: string };

export type RetailerBasketResult = {
  retailer_id: string;
  retailer_name: string;
  lines: PricedLine[];
  items_matched: number;
  items_total: number;
  fully_stocked: boolean;
  missing_items: { basket_item_id: string; label: string }[];
  subtotal: number;
  delivery_fee: number;
  handling_fee: number;
  eta_minutes: number | null;
  basket_total: number;
};

export type BasketRanking = {
  winner: RetailerBasketResult | null;
  runner_up: RetailerBasketResult | null;
  /** Saving of winner vs runner-up. Null when there is no runner-up to
   * compare against (fewer than two fully-stocked retailers). */
  winner_saving: number | null;
  /** Retailer ids that were even eligible to win (fully stocked). */
  eligible_for_win: string[];
};

export type BasketResult = {
  retailers: RetailerBasketResult[]; // sorted by basket_total ascending
  ranking: BasketRanking;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function rankBasket(
  items: BasketItemInput[],
  retailers: RetailerBasketInput[],
): BasketResult {
  const qtyByItem = new Map(items.map((i) => [i.basket_item_id, i.qty]));
  const labelByItem = new Map(items.map((i) => [i.basket_item_id, i.label]));

  const results: RetailerBasketResult[] = retailers.map((r) => {
    const lineByItem = new Map(r.lines.map((l) => [l.basket_item_id, l]));
    let subtotal = 0;
    let matched = 0;
    const missing: { basket_item_id: string; label: string }[] = [];
    const lines: PricedLine[] = [];

    for (const item of items) {
      const line = lineByItem.get(item.basket_item_id);
      if (line && line.in_stock) {
        matched += 1;
        subtotal += line.price * item.qty;
        lines.push({ status: "priced", ...line });
      } else {
        missing.push({
          basket_item_id: item.basket_item_id,
          label: labelByItem.get(item.basket_item_id) ?? item.basket_item_id,
        });
        lines.push({ status: "missing", basket_item_id: item.basket_item_id });
      }
    }

    const deliveryFee = r.fees.delivery;
    const handlingFee = r.fees.handling;
    const basketTotal = round2(subtotal + deliveryFee + handlingFee);

    return {
      retailer_id: r.retailer_id,
      retailer_name: r.retailer_name,
      lines,
      items_matched: matched,
      items_total: items.length,
      fully_stocked: matched === items.length && items.length > 0,
      missing_items: missing,
      subtotal: round2(subtotal),
      delivery_fee: deliveryFee,
      handling_fee: handlingFee,
      eta_minutes: r.fees.eta_minutes,
      basket_total: basketTotal,
    };
  });

  // Deterministic ordering: basket_total asc, then delivery_fee asc, then
  // retailer_id asc. This also fixes tie-breaking for the ranking below.
  const sorted = [...results].sort((a, b) => {
    if (a.basket_total !== b.basket_total) return a.basket_total - b.basket_total;
    if (a.delivery_fee !== b.delivery_fee) return a.delivery_fee - b.delivery_fee;
    return a.retailer_id.localeCompare(b.retailer_id);
  });

  const eligible = sorted.filter((r) => r.fully_stocked);
  const winner = eligible[0] ?? null;
  const runnerUp = eligible[1] ?? null;
  const winnerSaving =
    winner && runnerUp ? round2(runnerUp.basket_total - winner.basket_total) : null;

  return {
    retailers: sorted,
    ranking: {
      winner,
      runner_up: runnerUp,
      winner_saving: winnerSaving,
      eligible_for_win: eligible.map((r) => r.retailer_id),
    },
  };
}
