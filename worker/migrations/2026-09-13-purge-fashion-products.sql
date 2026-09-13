-- DESTRUCTIVE AND IRREVERSIBLE. Read before running.
--
-- Removes every fashion product and its entire recorded price history. The
-- rows it deletes were collected before the men's-only change, when the
-- adapters searched the literal string "fashion-tops" and stored whatever
-- came back -- women's apparel included.
--
-- Run this ONLY AFTER a fashion sweep has succeeded with the men's mappings.
-- Running it first leaves the Deals screen empty until the next sweep lands,
-- which is strictly worse than a feed with some stale rows in it.
--
--   cd worker && npx wrangler d1 execute bachat --remote \
--     --file=migrations/2026-09-13-purge-fashion-products.sql
--
-- Child rows go first: products.id is referenced by five tables, so deleting
-- products first fails on the foreign keys.
DELETE FROM pending_alerts WHERE product_id IN (SELECT id FROM products WHERE mode = 'fashion');
DELETE FROM alerts         WHERE product_id IN (SELECT id FROM products WHERE mode = 'fashion');
DELETE FROM matches        WHERE product_id IN (SELECT id FROM products WHERE mode = 'fashion');
DELETE FROM price_daily    WHERE product_id IN (SELECT id FROM products WHERE mode = 'fashion');
DELETE FROM prices         WHERE product_id IN (SELECT id FROM products WHERE mode = 'fashion');
DELETE FROM products       WHERE mode = 'fashion';
