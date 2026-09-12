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

-- "What has been sent since <timestamp>?" — the sweep's dedupe read and the
-- app's alert-history view both scan by recency.
CREATE INDEX IF NOT EXISTS idx_alerts_sent_at ON alerts(sent_at DESC);

-- ---------------------------------------------------------------------------
-- pending_alerts (quiet-hours hold queue, spec section 7)
-- ---------------------------------------------------------------------------
-- Quiet-hours alerts are HELD and delivered in the morning, never dropped.
-- Each sweep is a fresh GitHub Actions process, so the queue cannot live in
-- memory: it must be durable between runs. Deliberately NO foreign key on
-- product_id — a held alert must survive even if the product row is later
-- rewritten, and losing a held alert is exactly the failure the spec forbids.
--
-- `payload` is the full engine Alert as JSON so nothing (message, category,
-- lowest_in_days) is reconstructed by guesswork on release; the promoted
-- columns exist only so the queue is queryable and orderable.
CREATE TABLE IF NOT EXISTS pending_alerts (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('threshold', 'period_low')),
  price         REAL NOT NULL,
  scheduled_for INTEGER NOT NULL, -- epoch ms; deliver at or after this
  payload       TEXT NOT NULL,    -- JSON-encoded engine Alert
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_alerts_scheduled
  ON pending_alerts(scheduled_for);

-- ---------------------------------------------------------------------------
-- categories (the sweepable category catalog — mode is DATA, not a prefix)
-- ---------------------------------------------------------------------------
-- `prefs.enabled_categories` stays a flat list of slugs (the mobile app
-- decodes it as a string list), so the quick-vs-fashion split has to come
-- from somewhere. It used to be inferred from a "fashion-" name prefix in
-- the collector; that guess is replaced by this table. A category the
-- catalog does not know has NO mode, and the sweep skips it loudly rather
-- than guessing one.
CREATE TABLE IF NOT EXISTS categories (
  slug  TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  mode  TEXT NOT NULL CHECK (mode IN ('quick', 'fashion'))
);

CREATE INDEX IF NOT EXISTS idx_categories_mode ON categories(mode);

INSERT OR IGNORE INTO categories (slug, label, mode) VALUES
  ('staples',             'Staples',           'quick'),
  ('dairy',               'Dairy',             'quick'),
  ('snacks',              'Snacks',            'quick'),
  ('beverages',           'Beverages',         'quick'),
  ('bakery',              'Bakery',            'quick'),
  ('fruits-vegetables',   'Fruits & Veg',      'quick'),
  ('personal-care',       'Personal Care',     'quick'),
  ('household',           'Household',         'quick'),
  ('fashion-tops',        'Tops',              'fashion'),
  ('fashion-bottoms',     'Bottoms',           'fashion'),
  ('fashion-footwear',    'Footwear',          'fashion'),
  ('fashion-accessories', 'Accessories',       'fashion');

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
  -- Hyderabad 500016 (Begumpet). A real default matters: BigBasket's listing
  -- API 400s outright without a delivery location, and Blinkit falls back to
  -- an IP-derived dark store, so a null location means a fresh deploy sweeps
  -- nothing until onboarding runs. Overwritten by the app's Phase 5 step.
  ('location',        '{"lat":17.4435,"lon":78.4645,"pincode":"500016"}'),
  ('fees.blinkit',    '{"delivery":25,"handling":0,"eta_minutes":15}'),
  ('fees.bigbasket',  '{"delivery":40,"handling":0,"eta_minutes":120}'),
  ('fees.myntra',     '{"delivery":0,"handling":0,"eta_minutes":null}'),
  ('fees.amazon',     '{"delivery":0,"handling":0,"eta_minutes":null}'),
  ('fees.flipkart',   '{"delivery":40,"handling":0,"eta_minutes":null}'),
  ('enabled_categories', '["staples","dairy","snacks","fashion-tops","fashion-bottoms"]');
