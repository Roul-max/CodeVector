# CodeVector Product Browser

## What this is

This is a backend for browsing about 200,000 products, newest first, filterable by category, and paginated in a way that stays correct even while products are being added or updated concurrently.

## Architecture

```text
Frontend/UI
    ↓
Express API
    ↓
PostgreSQL (Supabase)
```

## Stack

- Node.js
- Express
- PostgreSQL, hosted on Supabase
- Plain HTML and JavaScript frontend

This stack matches my existing experience and keeps the project focused on the backend behavior. PostgreSQL is a good fit because its tuple comparison syntax and composite indexes make the pagination logic clean to implement, reason about, and explain.

## The core problem and why OFFSET/LIMIT pagination is wrong here

The simple approach would be:

```sql
SELECT *
FROM products
ORDER BY created_at DESC
LIMIT 20 OFFSET 5000;
```

That has two problems for this project.

First, it gets slower the deeper the user paginates. To serve a page with a large offset, the database still has to walk through every row before that offset and discard those rows before returning the page. Page 1 is cheap, but page 500 means scanning and throwing away thousands of rows first.

Second, it is unsafe while writes are happening. OFFSET means "start at this numeric position in the current result set." If a new row is inserted while a user is halfway through browsing, every row after that insert shifts down by one position. The user can then see a product twice or skip a product entirely.

## The fix: keyset/cursor pagination

The server uses keyset pagination instead of offset pagination. The actual query shape in `src/server.js` is:

```sql
WHERE (created_at, id) < (cursor_created_at, cursor_id)
ORDER BY created_at DESC, id DESC
```

The cursor is the last `(created_at, id)` pair from the previous page. Instead of saying "skip N rows," the client says "give me the next rows older than this exact row."

This is backed by the composite index in `db/schema.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_products_created_at_id
  ON products (created_at DESC, id DESC);
```

There is also a category-aware index:

```sql
CREATE INDEX IF NOT EXISTS idx_products_category_created_at_id
  ON products (category, created_at DESC, id DESC);
```

This is fast at any page depth because PostgreSQL can do an indexed range scan from the cursor anchor instead of scanning and discarding rows. It is also safe under writes because the cursor is a fixed anchor, not a shifting numeric position.

## Why the cursor is (created_at, id) together, not created_at alone

`created_at` is not guaranteed to be unique. Multiple products can share the same timestamp, especially when rows are inserted in batches. If the cursor used only `created_at`, rows with the same timestamp could be skipped or repeated because the ordering would not be fully deterministic.

`id` is unique and monotonic because the schema uses `BIGSERIAL PRIMARY KEY`. Combining `created_at` with `id` gives a stable total order:

```sql
ORDER BY created_at DESC, id DESC
```

That pair is what makes the cursor precise.

## Why created_at and not updated_at is the sort/cursor key

"Newest first" means insertion order in this project, so the list is sorted by `created_at`, not `updated_at`.

That matters because editing a product should not move its position in the paginated list. If a product's price changes, `updated_at` changes, but its `created_at` stays the same. Existing cursors remain valid because the row does not jump to a different position in the sort order.

If `updated_at` were the sort key, any edit could move a row to the top of the list while a user is mid-browse. That would recreate the same duplicate/skip problem this design is avoiding.

## Seeding 200k rows fast

`scripts/seed.js` generates 200,000 products and inserts them in batches of 1,000 rows per statement.

Instead of running 200,000 individual INSERT statements, it builds parameterized multi-row INSERT statements like:

```sql
INSERT INTO products (name, category, price, created_at, updated_at)
VALUES (...), (...), (...);
```

That matters because individual inserts would spend a lot of time on network round trips and per-statement parse/plan overhead. Batching reduces the work to about 200 INSERT statements, which is much faster and still simple enough to explain.

The seed script also spreads `created_at` values over roughly the last 365 days so newest-first pagination has realistic data to sort.

## API reference

### GET /products

Returns a page of products sorted by `created_at DESC, id DESC`.

Query params:

- `category`: optional exact category filter
- `cursor`: optional opaque cursor from the previous response
- `limit`: optional page size, defaults to 20. Must be an integer from 1 to 100.

Example request:

```http
GET /products?category=Electronics&limit=20
```

Example response:

```json
{
  "data": [
    {
      "id": "202250",
      "name": "Live New Product 1782069063838-49",
      "category": "Electronics",
      "price": "99.99",
      "created_at": "2026-06-21T19:11:01.628Z",
      "updated_at": "2026-06-21T19:11:01.628Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA2LTIxVDE5OjExOjAxLjYyOFoiLCJpZCI6MjAyMjUwfQ==",
  "hasMore": true
}
```

The cursor is generated by the server as base64-encoded JSON:

```json
{
  "createdAt": "2026-06-21T19:11:01.628Z",
  "id": 202250
}
```

Invalid `limit` or malformed cursor values return HTTP 400 with a clear error message instead of falling through to a database error.

Invalid limit example:

```http
GET /products?limit=500
```

```json
{
  "error": "limit must be an integer between 1 and 100"
}
```

### GET /categories

Returns distinct product categories for the filter dropdown.

Example request:

```http
GET /categories
```

Example response:

```json
[
  "Automotive",
  "Beauty",
  "Books",
  "Clothing",
  "Electronics"
]
```

### POST /simulate-writes

Development helper used to test concurrent writes while browsing. It inserts `count` new products and updates `count` random existing products inside a transaction.

This route is disabled in production:

```js
if (process.env.NODE_ENV === "production") {
  return res.status(403).json({ error: "simulate-writes is disabled in production" });
}
```

Example request:

```http
POST /simulate-writes
Content-Type: application/json

{
  "count": 50
}
```

Example response:

```json
{
  "inserted": 50,
  "updated": 50
}
```

The route caps `count` at 500.
Invalid `count` values return HTTP 400.

### GET /health

Simple health check.

Example request:

```http
GET /health
```

Example response:

```json
{
  "ok": true
}
```

## Running locally

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm start
```

Fill `DATABASE_URL` in `.env` with the pooled connection string from Supabase Project Settings -> Database. Use port `6543` with Transaction mode.

After starting the server, open:

```text
http://localhost:3000
```

## Tests

The project uses Node's built-in test runner, so no extra test framework is required.

```bash
npm test
```

The integration tests in `test/products.test.js` require `DATABASE_URL`. They create temporary product categories and clean up after themselves.

Coverage includes:

- pagination returns page 1 and page 2 with no duplicate product IDs
- category filtering returns only rows from the requested category
- cursor pagination remains consistent when a newer product is inserted between page requests

## Test Results

These are integration tests executed against PostgreSQL.

```bash
npm test
```

Output:

```text
✔ pagination returns first page, second page, and no duplicate products
✔ category filter returns only products from the requested category
✔ cursor remains stable when a newer product is inserted between page loads

tests 3
pass 3
fail 0
```

## EXPLAIN ANALYZE evidence

Run these commands in PostgreSQL after seeding the database. Replace the timestamp and id values with the `createdAt` and `id` decoded from a real `nextCursor`.

### Unfiltered pagination

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, category, price, created_at, updated_at
FROM products
WHERE (created_at, id) < ('2026-06-21T19:11:01.628Z'::timestamptz, 202250)
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

Expected index:

```text
idx_products_created_at_id
```

### Category-filtered pagination

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, category, price, created_at, updated_at
FROM products
WHERE category = 'Electronics'
  AND (created_at, id) < ('2026-06-21T19:11:01.628Z'::timestamptz, 202250)
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

Expected index:

```text
idx_products_category_created_at_id
```

Healthy query plan signs:

- `Index Scan` or `Index Only Scan` using the expected composite index
- no explicit `Sort` node for `ORDER BY created_at DESC, id DESC`
- rows scanned should be close to the page size, usually around `LIMIT 21`
- execution time should stay low even for deep cursors
- buffer reads should be small and stable between early and later pages

Problem signs:

- `Seq Scan on products`
- explicit `Sort` over many rows
- high `Rows Removed by Filter`
- scanned rows growing with page depth
- execution time increasing as the cursor moves deeper into the table

## How to verify correctness under concurrent writes

1. Start on page 1 in the UI or call `GET /products`.
2. Paginate forward a few pages and keep track of the product IDs you have seen.
3. Without going back to page 1, call `POST /simulate-writes` or click the "Simulate 50 writes" button in the UI.
4. Continue paginating forward using the existing cursor flow.
5. Confirm that products on the pages you have not revisited are not repeated or skipped.

The new products should appear above your current position because they have newer `created_at` values. They should not appear in the middle of the already anchored pagination path.

## Known issue I hit and fixed

The `simulate-writes` button initially appeared not to work because the click handler fired the POST request successfully but never refreshed the visible product list afterward. The database write succeeded, but the UI looked unchanged.

I fixed it by checking the POST response and re-fetching the current page after the write completes.

## What I'd improve with more time

- Add HMAC-signed cursors to prevent cursor tampering.
- Add rate limiting, monitoring, and alerting.
- Load test pagination with 1M+ products.
- Generate automated benchmark reports for pagination latency.

## How I used AI

AI helped with implementation details, debugging, and code review. I evaluated the tradeoffs myself and made the final decisions regarding pagination strategy, indexing, testing, and cursor design.
