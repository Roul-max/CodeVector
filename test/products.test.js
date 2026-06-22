const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";

const { app, pool } = require("../src/server");

const hasDatabase = Boolean(process.env.DATABASE_URL);
let server;
let baseUrl;
const testCategories = [];

before(async () => {
  if (!hasDatabase) return;

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (testCategories.length) {
    await pool.query(
      "DELETE FROM products WHERE category = ANY($1)",
      [testCategories]
    );
  }

  await pool.end();

  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function skipWithoutDatabase(t) {
  if (!hasDatabase) {
    t.skip("DATABASE_URL is required for integration tests");
    return true;
  }
  return false;
}

function uniqueCategory(label) {
  const category = `Test ${label} ${Date.now()} ${Math.random()
    .toString(16)
    .slice(2)}`;

  testCategories.push(category);
  return category;
}

async function insertProducts(category, count) {
  const values = [];
  const placeholders = [];
  const baseTime = Date.now() - 60_000;

  for (let i = 0; i < count; i++) {
    const offset = i * 5;
    const timestamp = new Date(baseTime - i * 1000);

    values.push(
      `${category} Product ${i}`, // name
      category,                   // category
      "10.00",                    // price
      timestamp,                  // created_at
      timestamp                   // updated_at
    );

    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
    );
  }

  await pool.query(
    `INSERT INTO products (name, category, price, created_at, updated_at)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

async function fetchProducts(params) {
  const response = await fetch(
    `${baseUrl}/products?${new URLSearchParams(params)}`
  );

  const body = await response.json();

  return { response, body };
}

test(
  "pagination returns first page, second page, and no duplicate products",
  async (t) => {
    if (skipWithoutDatabase(t)) return;

    const category = uniqueCategory("Pagination");
    await insertProducts(category, 7);

    const first = await fetchProducts({
      category,
      limit: "3",
    });

    assert.equal(first.response.status, 200);
    assert.equal(first.body.data.length, 3);
    assert.ok(first.body.nextCursor);

    const second = await fetchProducts({
      category,
      limit: "3",
      cursor: first.body.nextCursor,
    });

    assert.equal(second.response.status, 200);
    assert.equal(second.body.data.length, 3);

    const seen = new Set(
      first.body.data.map((product) => product.id)
    );

    for (const product of second.body.data) {
      assert.equal(seen.has(product.id), false);
    }
  }
);

test(
  "category filter returns only products from the requested category",
  async (t) => {
    if (skipWithoutDatabase(t)) return;

    const requestedCategory = uniqueCategory("Category");
    const otherCategory = uniqueCategory("Other");

    await insertProducts(requestedCategory, 4);
    await insertProducts(otherCategory, 4);

    const result = await fetchProducts({
      category: requestedCategory,
      limit: "10",
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.length, 4);

    assert.ok(
      result.body.data.every(
        (product) => product.category === requestedCategory
      )
    );
  }
);

test(
  "cursor remains stable when a newer product is inserted between page loads",
  async (t) => {
    if (skipWithoutDatabase(t)) return;

    const category = uniqueCategory("Consistency");
    await insertProducts(category, 7);

    const first = await fetchProducts({
      category,
      limit: "3",
    });

    assert.equal(first.response.status, 200);
    assert.equal(first.body.data.length, 3);

    await pool.query(
      `INSERT INTO products (name, category, price, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      ["Newer Consistency Product", category, "99.99"]
    );

    const second = await fetchProducts({
      category,
      limit: "3",
      cursor: first.body.nextCursor,
    });

    assert.equal(second.response.status, 200);

    const firstPageIds = new Set(
      first.body.data.map((product) => product.id)
    );

    for (const product of second.body.data) {
      assert.equal(firstPageIds.has(product.id), false);
    }
  }
);