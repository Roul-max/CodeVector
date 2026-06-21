-- Products table.
-- id is a UUID (or bigserial — see note below) so it can be combined with
-- created_at to form a stable, unique cursor for pagination.

CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,        -- unique, always increasing -> perfect tiebreaker
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       NUMERIC(10, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE KEY INDEX.
-- "Newest first" pagination sorts by created_at DESC, id DESC.
-- A composite index on exactly those two columns, in that order, lets
-- Postgres satisfy "ORDER BY created_at DESC, id DESC ... WHERE (created_at, id) < (?, ?)"
-- with a single index range scan -- no sort step, no full scan, no OFFSET cost.
CREATE INDEX IF NOT EXISTS idx_products_created_at_id
  ON products (created_at DESC, id DESC);

-- Supports fast category filtering combined with the same cursor logic.
CREATE INDEX IF NOT EXISTS idx_products_category_created_at_id
  ON products (category, created_at DESC, id DESC);
