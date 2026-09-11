-- Bachat D1 schema
-- Spec: docs/superpowers/specs/2026-09-12-bachat-design.md section 5
--
-- Design notes:
--  * `prices` is append-only, pruned to 90 days by the daily rollup job.
--  * `price_daily` is the ONLY table the 30-day-low query reads. It is
--    written by the same ingest transaction that appends to `prices`, so it
--    never drifts and the low-price query stays O(30 rows/product) instead
--    of O(all historical sweeps).
--  * Every index below exists to serve one of the hot queries called out in
--    spec section 4/8: latest price per product per retailer (basket,
--    compare), 30-day-low lookups (history, deal engine honesty rule), and
--    basket item -> product -> retailer joins.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- retailers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retailers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('quick', 'fashion')),
  deeplink_tpl TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES retailers(id),
  ext_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  brand       TEXT,
  size        TEXT,
  pack        TEXT,
  image_url   TEXT,
  url         TEXT,
  category    TEXT,
  mode        TEXT NOT NULL CHECK (mode IN ('quick', 'fashion')),
  UNIQUE (retailer_id, ext_id)
);

CREATE INDEX IF NOT EXISTS idx_products_retailer   ON products(retailer_id);
CREATE INDEX IF NOT EXISTS idx_products_mode_cat    ON products(mode, category);
CREATE INDEX IF NOT EXISTS idx_products_brand       ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_name        ON products(name);

-- ---------------------------------------------------------------------------
-- prices (append-only observations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES products(id),
  price       REAL NOT NULL,
  mrp         REAL,
  in_stock    INTEGER NOT NULL DEFAULT 1,
  captured_at INTEGER NOT NULL
);

-- Hottest query: "latest price row for product X" (basket, compare, deals).
-- DESC on captured_at lets us take the first matching row without a sort.
-- UNIQUE also gives /api/ingest idempotency for free: re-posting the same
-- sweep (same product, same captured_at) is a no-op via INSERT OR IGNORE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_product_captured
  ON prices(product_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- price_daily (rollup; the 30-day-low query reads ONLY this table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_daily (
  product_id TEXT NOT NULL REFERENCES products(id),
  day        TEXT NOT NULL, -- ISO date, e.g. '2026-09-12'
  min_price  REAL NOT NULL,
  max_price  REAL NOT NULL,
  PRIMARY KEY (product_id, day)
);

-- Supports "last 30 rows for this product, most recent first" and also lets
-- the deal engine compute days_observed as COUNT(*) over the window cheaply.
CREATE INDEX IF NOT EXISTS idx_price_daily_product_day
  ON price_daily(product_id, day DESC);

-- ---------------------------------------------------------------------------
-- basket_items / matches (bridge: one user item -> one product per retailer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS basket_items (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 1,
  mode     TEXT NOT NULL CHECK (mode IN ('quick', 'fashion')),
  category TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  basket_item_id TEXT NOT NULL REFERENCES basket_items(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  confidence     REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (basket_item_id, product_id)
);

-- Basket screen joins matches -> products -> latest prices constantly.
CREATE INDEX IF NOT EXISTS idx_matches_item     ON matches(basket_item_id);
CREATE INDEX IF NOT EXISTS idx_matches_product  ON matches(product_id);

-- ---------------------------------------------------------------------------
-- saved_searches / prefs / alerts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_searches (
  id        TEXT PRIMARY KEY,
  mode      TEXT NOT NULL CHECK (mode IN ('quick', 'fashion')),
  query     TEXT NOT NULL,
  brands    TEXT, -- JSON array
  sizes     TEXT, -- JSON array
  max_price REAL
);

CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON-encoded value, see worker/src/lib/prefs.ts for keys
);

CREATE TABLE IF NOT EXISTS alerts (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  kind       TEXT NOT NULL CHECK (kind IN ('threshold', 'period_low')),
  price      REAL NOT NULL,
  sent_at    INTEGER NOT NULL
);

-- Dedupe check: "has this product/kind/price already alerted?"
CREATE INDEX IF NOT EXISTS idx_alerts_product_kind_price
  ON alerts(product_id, kind, price);

-- ---------------------------------------------------------------------------
-- device registration for FCM push (implied by POST /api/register-device)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  token        TEXT PRIMARY KEY,
  platform     TEXT,
  registered_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Seed data: the five v1 retailers (spec section 3)
-- Deep-link templates use {ext_id} / {q} placeholders the app substitutes.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO retailers (id, name, mode, deeplink_tpl) VALUES
  ('blinkit',   'Blinkit',   'quick',   'blinkit://product/{ext_id}?utm_source=bachat'),
  ('bigbasket', 'BigBasket', 'quick',   'bigbasket://product/{ext_id}?utm_source=bachat'),
  ('myntra',    'Myntra',    'fashion', 'myntra://product/{ext_id}?utm_source=bachat'),
  ('amazon',    'Amazon.in', 'fashion', 'https://www.amazon.in/dp/{ext_id}?tag=bachat'),
  ('flipkart',  'Flipkart',  'fashion', 'https://www.flipkart.com/p/{ext_id}?affid=bachat');

-- ---------------------------------------------------------------------------
-- Seed default prefs (delivery/handling fees per retailer, threshold, quiet
-- hours). All user-editable via POST /api/prefs; fees are NEVER scraped.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO prefs (key, value) VALUES
  ('threshold_pct',   '0.6'),
  ('quiet_hours',     '{"start":"23:00","end":"08:00","tz":"Asia/Kolkata"}'),
  ('location',        '{"lat":null,"lon":null,"pincode":null}'),
  ('fees.blinkit',    '{"delivery":25,"handling":0,"eta_minutes":15}'),
  ('fees.bigbasket',  '{"delivery":40,"handling":0,"eta_minutes":120}'),
  ('fees.myntra',     '{"delivery":0,"handling":0,"eta_minutes":null}'),
  ('fees.amazon',     '{"delivery":0,"handling":0,"eta_minutes":null}'),
  ('fees.flipkart',   '{"delivery":40,"handling":0,"eta_minutes":null}'),
  ('enabled_categories', '["staples","dairy","snacks","fashion-tops","fashion-bottoms"]');
