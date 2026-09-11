// Applies worker/schema.sql to a test database (see d1-shim.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { D1Shim } from "./d1-shim";

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

export function applySchema(db: D1Shim): void {
  const sql = readFileSync(schemaPath, "utf-8");
  const statements = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "")) // strip full-line and trailing comments
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    db.exec(statement.replace(/\s+/g, " "));
  }
}

export function resetData(db: D1Shim): void {
  const tables = [
    "alerts",
    "pending_alerts",
    "matches",
    "basket_items",
    "price_daily",
    "prices",
    "products",
    "saved_searches",
    "devices",
  ];
  for (const t of tables) {
    db.exec(`DELETE FROM ${t}`);
  }
}
