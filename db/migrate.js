#!/usr/bin/env node
/**
 * DemandScan — Database migration runner
 *
 * Applies db/schema.sql to the Neon Postgres database configured via
 * DATABASE_URL in your .env.local file.
 *
 * Usage:
 *   node db/migrate.js
 *
 * This script is IDEMPOTENT — safe to run multiple times.
 * It does NOT drop or truncate any existing tables.
 */

const { readFileSync } = require("fs");
const { join } = require("path");

// Load .env.local manually for local dev (Neon SDK expects DATABASE_URL)
try {
  require("dotenv").config({ path: join(__dirname, "..", ".env.local") });
} catch {
  // dotenv not installed or .env.local missing — rely on process.env
}

async function migrate() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "ERROR: DATABASE_URL is not set.\n" +
        "Add it to .env.local (local) or Vercel environment variables (production)."
    );
    process.exit(1);
  }

  const { neon } = require("@neondatabase/serverless");
  const sql = neon(url);

  const schemaPath = join(__dirname, "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");

  console.log("Applying db/schema.sql to Neon Postgres…");

  // Neon's HTTP transport does not support multi-statement batches in a single
  // call. Split on semicolons, strip SQL comments and blank lines, then execute
  // each non-empty statement individually.
  // The schema file contains only static DDL — no user-supplied parameters.
  const statements = schemaSql
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await sql.query(stmt, []);
  }

  console.log(`Migration complete (${statements.length} statement(s) applied). Table kite_sessions is ready.`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
