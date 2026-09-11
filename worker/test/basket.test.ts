import { describe, expect, it } from "vitest";
import { rankBasket, type RetailerBasketInput, type BasketItemInput } from "../src/lib/basket";

const items: BasketItemInput[] = [
  { basket_item_id: "i1", label: "Amul Taaza 500ml", qty: 2 },
  { basket_item_id: "i2", label: "Bread", qty: 1 },
];

function line(basket_item_id: string, price: number, in_stock = true) {
  return {
    basket_item_id,
    product_id: `p-${basket_item_id}`,
    name: basket_item_id,
    price,
    mrp: null,
    in_stock,
    captured_at: 1,
  };
}

describe("rankBasket", () => {
  it("ranks fully-stocked retailers by basket total, including fees", () => {
    const retailers: RetailerBasketInput[] = [
      {
        retailer_id: "zepto",
        retailer_name: "Zepto",
        fees: { delivery: 25, handling: 0, eta_minutes: 10 },
        lines: [line("i1", 30), line("i2", 20)], // subtotal 2*30+20=80 +25=105
      },
      {
        retailer_id: "blinkit",
        retailer_name: "Blinkit",
        fees: { delivery: 10, handling: 0, eta_minutes: 15 },
        lines: [line("i1", 35), line("i2", 22)], // subtotal 92 +10=102
      },
    ];

    const result = rankBasket(items, retailers);
    expect(result.ranking.winner?.retailer_id).toBe("blinkit");
    expect(result.ranking.runner_up?.retailer_id).toBe("zepto");
    // saving vs runner-up: 105 - 102 = 3
    expect(result.ranking.winner_saving).toBe(3);
    expect(result.ranking.eligible_for_win).toEqual(["blinkit", "zepto"]);
  });

  it("never lets a partial-stock retailer win outright, and states its gap", () => {
    const retailers: RetailerBasketInput[] = [
      {
        retailer_id: "cheap-but-missing",
        retailer_name: "CheapButMissing",
        fees: { delivery: 0, handling: 0, eta_minutes: null },
        lines: [line("i1", 1)], // absurdly cheap but missing item i2 entirely
      },
      {
        retailer_id: "full-stock",
        retailer_name: "FullStock",
        fees: { delivery: 40, handling: 0, eta_minutes: 120 },
        lines: [line("i1", 30), line("i2", 20)],
      },
    ];

    const result = rankBasket(items, retailers);
    expect(result.ranking.winner?.retailer_id).toBe("full-stock");
    expect(result.ranking.eligible_for_win).toEqual(["full-stock"]);
    // no runner-up because only one fully-stocked retailer -> saving is null,
    // never computed against the partial (worst) option.
    expect(result.ranking.runner_up).toBeNull();
    expect(result.ranking.winner_saving).toBeNull();

    const missingRetailer = result.retailers.find((r) => r.retailer_id === "cheap-but-missing");
    expect(missingRetailer?.fully_stocked).toBe(false);
    expect(missingRetailer?.missing_items).toEqual([{ basket_item_id: "i2", label: "Bread" }]);
  });

  it("treats an out-of-stock matched line as missing, not priced", () => {
    const retailers: RetailerBasketInput[] = [
      {
        retailer_id: "r1",
        retailer_name: "R1",
        fees: { delivery: 0, handling: 0, eta_minutes: null },
        lines: [line("i1", 30), line("i2", 20, false)],
      },
    ];
    const result = rankBasket(items, retailers);
    const r1 = result.retailers[0]!;
    expect(r1.fully_stocked).toBe(false);
    expect(r1.items_matched).toBe(1);
    expect(r1.missing_items.map((m) => m.basket_item_id)).toEqual(["i2"]);
  });

  it("breaks ties deterministically by delivery fee, then retailer id", () => {
    const retailers: RetailerBasketInput[] = [
      {
        retailer_id: "b",
        retailer_name: "B",
        fees: { delivery: 10, handling: 0, eta_minutes: null },
        lines: [line("i1", 30), line("i2", 10)], // subtotal 70 + 10 = 80
      },
      {
        retailer_id: "a",
        retailer_name: "A",
        fees: { delivery: 5, handling: 0, eta_minutes: null },
        lines: [line("i1", 35), line("i2", 5)], // subtotal 75 + 5 = 80
      },
      {
        retailer_id: "c",
        retailer_name: "C",
        fees: { delivery: 5, handling: 0, eta_minutes: null },
        lines: [line("i1", 30), line("i2", 15)], // subtotal 75 + 5 = 80
      },
    ];
    const result = rankBasket(items, retailers);
    // a and c tie on total (80) and delivery fee (5); alphabetical retailer_id wins.
    expect(result.retailers.map((r) => r.retailer_id)).toEqual(["a", "c", "b"]);
    expect(result.ranking.winner?.retailer_id).toBe("a");
    expect(result.ranking.runner_up?.retailer_id).toBe("c");
    expect(result.ranking.winner_saving).toBe(0);
  });

  it("returns no winner when no retailer is fully stocked", () => {
    const retailers: RetailerBasketInput[] = [
      {
        retailer_id: "r1",
        retailer_name: "R1",
        fees: { delivery: 0, handling: 0, eta_minutes: null },
        lines: [line("i1", 30)],
      },
    ];
    const result = rankBasket(items, retailers);
    expect(result.ranking.winner).toBeNull();
    expect(result.ranking.eligible_for_win).toEqual([]);
  });
});
