-- Fashion is men's-only for now (product decision, 2026-09-13).
--
-- The slugs deliberately do NOT change. `prefs.enabled_categories` stores
-- slugs, the app's category picker filters on them, and every existing
-- `products.category` value is one -- so renaming them would mean migrating
-- all three. The gender lives in the adapters' CATEGORY_IDS translation
-- instead; this file only makes the labels the app displays tell the truth.
--
-- schema.sql seeds these with INSERT OR IGNORE, which does nothing to rows
-- that already exist, so a deployed database needs this UPDATE explicitly.
UPDATE categories SET label = 'Men''s Tops'        WHERE slug = 'fashion-tops';
UPDATE categories SET label = 'Men''s Bottoms'     WHERE slug = 'fashion-bottoms';
UPDATE categories SET label = 'Men''s Footwear'    WHERE slug = 'fashion-footwear';
UPDATE categories SET label = 'Men''s Accessories' WHERE slug = 'fashion-accessories';
