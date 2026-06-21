/**
 * Seed script — generates 200,000 products.
 *
 * WHY NOT A LOOP OF INSERT STATEMENTS:
 * 200,000 individual `INSERT INTO ... VALUES (...)` round trips would take
 * several minutes (network + parse/plan overhead per statement dominates).
 *
 * INSTEAD: we batch many rows into a single multi-row INSERT
 * (`INSERT INTO products (...) VALUES (...), (...), (...) ...`)
 * and send a few hundred such batched statements instead of 200,000 tiny ones.
 * This typically finishes in well under a minute, even against a remote
 * free-tier DB like Supabase.
 *
 * (The fastest possible approach is Postgres COPY via pg-copy-streams, but
 * batched multi-row INSERT is ~90% as fast, needs no extra dependency, and
 * is much easier to explain/defend live — which matters more here.)
 */

const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TOTAL_PRODUCTS = 200_000;
const BATCH_SIZE = 1_000; // rows per INSERT statement

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

const ADJECTIVES = ["Premium", "Compact", "Wireless", "Eco", "Pro", "Classic", "Smart", "Portable", "Deluxe", "Essential"];
const NOUNS = ["Blender", "Headphones", "Backpack", "Lamp", "Notebook", "Chair", "Bottle", "Charger", "Speaker", "Jacket"];

function randomProduct(i) {
  const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]} ${i}`;
  const price = (Math.random() * 490 + 10).toFixed(2); // 10.00–500.00

  // Spread created_at over the last ~365 days so "newest first" is meaningful.
  const daysAgo = Math.random() * 365;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  return { name, category, price, createdAt };
}

async function seed() {
  console.log(`Seeding ${TOTAL_PRODUCTS} products in batches of ${BATCH_SIZE}...`);
  const start = Date.now();

  await pool.query("TRUNCATE TABLE products RESTART IDENTITY");

  for (let offset = 0; offset < TOTAL_PRODUCTS; offset += BATCH_SIZE) {
    const rows = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      rows.push(randomProduct(offset + i));
    }

    // Build a single parameterized multi-row INSERT:
    // INSERT INTO products (name, category, price, created_at, updated_at)
    // VALUES ($1,$2,$3,$4,$4), ($5,$6,$7,$8,$8), ...
    const values = [];
    const placeholders = rows
      .map((r, idx) => {
        const base = idx * 4;
        values.push(r.name, r.category, r.price, r.createdAt);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 4})`;
      })
      .join(", ");

    const sql = `
      INSERT INTO products (name, category, price, created_at, updated_at)
      VALUES ${placeholders}
    `;

    await pool.query(sql, values);

    if ((offset / BATCH_SIZE) % 20 === 0) {
      console.log(`  inserted ${offset + BATCH_SIZE} / ${TOTAL_PRODUCTS}`);
    }
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done. Inserted ${TOTAL_PRODUCTS} products in ${seconds}s.`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
