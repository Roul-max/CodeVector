/**
 * Backend for browsing 200k products: newest-first, filterable, paginated.
 *
 * THE CORE IDEA — KEYSET (CURSOR) PAGINATION, NOT OFFSET/LIMIT
 * ---------------------------------------------------------------
 * OFFSET/LIMIT (`... ORDER BY created_at DESC LIMIT 20 OFFSET 5000`) has two
 * problems at 200k+ rows:
 *
 *   1. SLOW: Postgres must walk and discard `OFFSET` rows on every request.
 *      Page 1 is instant; page 500 is scanning/discarding 10,000 rows first.
 *
 *   2. UNSTABLE UNDER WRITES: OFFSET means "the Nth row in the current sort
 *      order." If a row is inserted above your position while you're
 *      paginating, every row below it shifts down by one — you'll either
 *      see the row you already saw again (duplicate) or skip a row entirely.
 *
 * Cursor pagination fixes both: instead of "skip N rows," the client sends
 * "give me everything older than the last (created_at, id) pair I saw."
 * That's a fixed anchor point in a stable sort key, not a position that
 * shifts when other rows are inserted elsewhere. Each page is then a direct
 * indexed range scan (`WHERE (created_at, id) < (?, ?) ORDER BY ... LIMIT ?`)
 * — equally fast on page 1 or page 5,000.
 *
 * WHY (created_at, id) AND NOT JUST created_at:
 * created_at is NOT unique — many products can share a timestamp (e.g. ones
 * seeded in the same batch). Sorting/cursoring on created_at alone could
 * skip or duplicate rows that share an exact timestamp. id is unique and
 * monotonically increasing, so the *pair* (created_at, id) is always a
 * unique, totally-ordered key — a safe cursor.
 *
 * WHY UPDATES DON'T BREAK THIS:
 * "Newest first" is defined as sorted by created_at (insertion order), not
 * updated_at. So editing an existing product's price/name does NOT move it
 * in the list or invalidate cursors already issued — it just changes the
 * data displayed if/when the user reaches that row again. Sorting by
 * updated_at instead would make resorting on edits, causing rows to jump
 * around mid-pagination — exactly the duplicate/skip bug the task warns about.
 */

const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ID_PATTERN = /^\d+$/;
const CATEGORIES = [
  "Electronics",
  "Home & Kitchen",
  "Books",
  "Clothing",
  "Sports",
  "Toys",
  "Beauty",
  "Automotive",
  "Garden",
  "Office Supplies",
];

function validateLimit(rawLimit) {
  if (rawLimit === undefined) return { limit: DEFAULT_LIMIT };
  if (Array.isArray(rawLimit)) {
    return { error: "limit must be a single integer between 1 and 100" };
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: "limit must be an integer between 1 and 100" };
  }

  return { limit };
}

function validateCount(rawCount) {
  if (rawCount === undefined) return { count: 50 };

  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return { error: "count must be an integer between 1 and 500" };
  }

  return { count };
}

function isValidBase64(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }

  return Buffer.from(value, "base64").toString("base64") === value;
}

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isValidId(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0;
  return typeof value === "string" && ID_PATTERN.test(value) && Number(value) > 0;
}

// Cursor is base64(JSON.stringify({ createdAt, id })) - opaque to the client,
// easy to validate on the server.
function encodeCursor(createdAt, id) {
  return Buffer.from(
    JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id: Number(id) })
  ).toString("base64");
}

function decodeCursor(cursor) {
  if (Array.isArray(cursor)) {
    return { error: "cursor must be a single value" };
  }
  if (!isValidBase64(cursor)) {
    return { error: "cursor must be valid base64" };
  }

  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { error: "cursor must decode to valid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "cursor JSON must be an object" };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "createdAt")) {
    return { error: "cursor is missing createdAt" };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "id")) {
    return { error: "cursor is missing id" };
  }
  if (!isValidTimestamp(parsed.createdAt)) {
    return { error: "cursor createdAt must be a valid ISO timestamp" };
  }
  if (!isValidId(parsed.id)) {
    return { error: "cursor id must be a positive integer" };
  }

  return { createdAt: parsed.createdAt, id: Number(parsed.id) };
}

/**
 * GET /products
 * Query params:
 *   limit     - page size (default 20, max 100)
 *   category  - optional exact-match filter
 *   cursor    - opaque cursor from the previous page's `nextCursor`
 *               (omit for the first page)
 */
app.get("/products", async (req, res) => {
  const limitResult = validateLimit(req.query.limit);
  if (limitResult.error) {
    return res.status(400).json({ error: limitResult.error });
  }

  const { limit } = limitResult;
  const { category, cursor } = req.query;

  const conditions = [];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded.error) {
      return res.status(400).json({ error: decoded.error });
    }
    params.push(decoded.createdAt);
    params.push(decoded.id);
    // Composite comparison: strictly "older" than the last row seen.
    conditions.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Fetch one extra row to know whether there's a next page, without a
  // separate COUNT(*) query (COUNT over 200k rows is itself slow).
  params.push(limit + 1);
  const sql = `
    SELECT id, name, category, price, created_at, updated_at
    FROM products
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length}
  `;

  try {
    const { rows } = await pool.query(sql, params);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    res.json({
      data: page,
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
      hasMore,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /categories — distinct categories for a filter dropdown.
 */
app.get("/categories", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT DISTINCT category FROM products ORDER BY category"
    );
    res.json(rows.map((r) => r.category));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /simulate-writes — dev-only helper to prove correctness under
 * concurrent writes. Inserts N new products and updates N random existing
 * ones, simulating "50 products added/updated while someone is browsing."
 */
app.post("/simulate-writes", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "simulate-writes is disabled in production" });
  }

  const countResult = validateCount(req.body?.count);
  if (countResult.error) {
    return res.status(400).json({ error: countResult.error });
  }

  const n = countResult.count;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < n; i++) {
      const category = CATEGORIES[i % CATEGORIES.length];
      await client.query(
        `INSERT INTO products (name, category, price, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [`Live New Product ${Date.now()}-${i}`, category, 99.99]
      );
    }
    await client.query(
      `UPDATE products SET price = price + 1, updated_at = now()
       WHERE id IN (SELECT id FROM products ORDER BY random() LIMIT $1)`,
      [n]
    );
    await client.query("COMMIT");
    res.json({ inserted: n, updated: n });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "simulate-writes failed" });
  } finally {
    client.release();
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, pool, encodeCursor, decodeCursor };
