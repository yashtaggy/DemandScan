# Live Trade — Production Migration Checklist

Status: prepared 2026-11-07. **Nothing in this document has been executed.**
No database has been contacted, no SQL has run, and the Live Trade migration is
still unapplied everywhere.

Scope: apply exactly one file — `db/migrations/2026-11-06-add-live-trade.sql` —
to the existing DemandScan production Neon database. There is no rehearsal
database for this phase.

This document contains variable **names** and placeholders only. Never paste a
real connection string, password, or token into this file, a shell history that
is shared, a ticket, or a chat.

---

## 1. What the migration changes

The file creates three new tables and six new indexes. It contains no `ALTER`,
`DROP`, `TRUNCATE`, `DELETE`, `INSERT`, or `UPDATE` statement (the test suite
asserts this):

| Object | Kind |
|---|---|
| `live_trade_groups` | new table + 1 unique index + 1 index |
| `live_trade_items` | new table + 1 unique index + 3 indexes |
| `live_trade_quote_state` | new table |

Consequences:

- Existing scanner tables are not modified, rewritten, or reindexed.
- Scanner, Dashboard, ingestion, and existing API behavior are unaffected by the
  schema change itself; the Live Trade code paths are separate routes.
- Every statement uses `IF NOT EXISTS`, so re-running is safe for objects that
  already exist.
- Creating `live_trade_items` with a foreign key to `instruments` takes a brief
  `SHARE ROW EXCLUSIVE` lock on `instruments`. Reads are unaffected; concurrent
  writes to `instruments` (ingestion) can pause for the duration of that single
  statement. Prefer a moment when no ingestion or scan is writing.

## 2. Commands that must NOT be used for this phase

| Command | Why it is excluded |
|---|---|
| `npm run db:migrate` / `node db/migrate.js` | applies `db/schema.sql` **and every** file in `db/migrations/`, which is broader than the approved change |
| `npm run db:staging:migrate` | staging wrapper; it delegates to `db/migrate.js` and the staging guard rejects the production host |
| `npm run db:staging:preflight` / `db:staging:verify` | staging-guarded; not valid against production |
| Any ad-hoc `psql`/Neon SQL Editor session | no guard, no preflight, no approval check |

Only these three commands are part of this procedure:

```
npm run db:production:live-trade:preflight
npm run db:production:live-trade:migrate
npm run db:production:live-trade:verify
```

## 3. Create the production environment file (manual operator step)

The file must live **outside** the repository. It is never committed and never
referenced from `.env.local`.

1. Create the directory (Git Bash / macOS / Linux):
   ```bash
   mkdir -p "$HOME/.config/demandscan"
   ```
   On Windows PowerShell use `$env:USERPROFILE\.config\demandscan`.
2. Create `$HOME/.config/demandscan/production-migrate.env` with a single line:
   ```
   DATABASE_URL=<direct production Neon connection string>
   ```
   - Use the **direct** (non-pooled) host: `ep-<id>.<region>.aws.neon.tech`.
   - Keep `?sslmode=require`.
   - Exactly one `DATABASE_URL` line — a duplicate is rejected as ambiguous.
3. Copy the value from the Neon Console for the **production** project. Do not
   reuse a staging URL and do not add other variables to this file.
4. Restrict access to the file where the operating system allows it
   (`chmod 600` on POSIX systems).

## 4. Required environment variables (names only)

| Variable | Required for | Meaning |
|---|---|---|
| `PRODUCTION_MIGRATE_ENV` | all three commands | path to the file created in §3 |
| `EXPECTED_PRODUCTION_HOST` | all three commands | direct production Neon hostname, e.g. `ep-<id>.<region>.aws.neon.tech` |
| `ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION` | migrate only | must be exactly `YES` |

Set them per-command rather than exporting them into a long-lived shell, so the
approval flag does not survive the migration:

```bash
export PRODUCTION_MIGRATE_ENV="$HOME/.config/demandscan/production-migrate.env"
export EXPECTED_PRODUCTION_HOST="ep-<production-id>.<region>.aws.neon.tech"
# approval flag is passed only on the migrate command line (§7)
```

Before running anything, make sure the shell has **no** inherited target:

```bash
env -u DATABASE_URL -u DB_ENV_FILE env | grep -E '^(DATABASE_URL|DB_ENV_FILE)=' || echo "clean"
```

The guard rejects an inherited `DATABASE_URL` outright (`DATABASE_URL_INHERITED`)
— it is never used as a fallback — and rejects `DB_ENV_FILE`
(`ENV_FILE_CONFLICT`).

## 5. Exact production guard checks

The production guard (`db/production-guard.js`) is a separate module from the
staging guard. The staging guard's rejection of the production hostname is not
weakened or bypassed; only credential-free parsing helpers are shared.

Rejected before any connection is opened:

| Check | Failure code |
|---|---|
| Write requested without `ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION=YES` | `PRODUCTION_APPROVAL_MISSING` |
| `PRODUCTION_MIGRATE_ENV` unset or empty (no `.env.local` fallback) | `ENV_FILE_NOT_SELECTED` |
| File does not exist / is not a file | `ENV_FILE_MISSING`, `ENV_FILE_INVALID` |
| File inside the repository | `ENV_FILE_INSIDE_REPO` |
| `DATABASE_URL` present in the process environment | `DATABASE_URL_INHERITED` |
| `DB_ENV_FILE` set, or a staging variable pointing at the same file | `ENV_FILE_CONFLICT` |
| `EXPECTED_PRODUCTION_HOST` unset | `EXPECTED_HOST_MISSING` |
| Expected host not `*.neon.tech`, or pooled | `EXPECTED_HOST_INVALID` |
| Expected host equal to `EXPECTED_STAGING_HOST` | `HOST_CONFUSION` |
| File has no / more than one `DATABASE_URL` | `DATABASE_URL_MISSING`, `DATABASE_URL_AMBIGUOUS` |
| URL not parseable or not `postgres(ql)://` | `DATABASE_URL_INVALID` |
| Target host not `*.neon.tech` | `TARGET_NOT_NEON` |
| Target host pooled | `TARGET_NOT_DIRECT` |
| Target host ≠ `EXPECTED_PRODUCTION_HOST` | `TARGET_HOST_MISMATCH` |

Guard rejection always exits `3`. Printed output is limited to mode, file
**basename**, host, port, database name, `sslmode`, and the neon/pooled flags.

## 6. Confirm the production hostname independently

1. Open the Neon Console for the **production** project (not staging).
2. Reveal the direct connection string and read only the host portion
   (`ep-...neon.tech`). Do not copy the password anywhere.
3. Compare it character for character with `EXPECTED_PRODUCTION_HOST`.
4. Confirm it is *not* the pooled form (`-pooler.`) and *not* the staging host.
5. Optional cross-check of the currently configured app target (prints host and
   database only): `npm run db:target`.

Exact-host equality is enforced by the guard at every invocation, including the
second evaluation immediately before the first write.

## 7. Create a restore point first

This migration is additive, but production has no rehearsal copy. Before the
first write:

1. In the Neon Console, create a **branch** of the production branch (or confirm
   the project's point-in-time restore window covers now, if your plan supports
   it).
2. Record the branch/restore point name and the timestamp in your own notes —
   never in the repository.
3. Confirm no ingestion job, scan, or deploy is running.

If your Neon plan provides neither branching nor PITR, stop and get an explicit
decision before proceeding: there would be no way to undo a partial apply other
than manual DDL.

## 8. Step 1 — read-only preflight

```bash
PRODUCTION_MIGRATE_ENV="$HOME/.config/demandscan/production-migrate.env" \
EXPECTED_PRODUCTION_HOST="ep-<production-id>.<region>.aws.neon.tech" \
npm run db:production:live-trade:preflight
```

Queries `information_schema.columns`, `pg_indexes`, and `pg_constraint` only.
It writes nothing and needs no approval flag.

Expected result:

| Status | Exit | Meaning |
|---|---|---|
| `READY_FRESH` | `0` | all prerequisite tables/columns present, no Live Trade table exists → migration may be applied |
| `READY_MIGRATED` | `0` | every Live Trade column, index, constraint and type present → already applied, nothing to do |
| `BLOCKED_PREREQUISITES` | `2` | a prerequisite table or column is missing |
| `BLOCKED_PARTIAL` | `2` | one or two Live Trade tables exist |
| `BLOCKED_INCOMPATIBLE` | `2` | Live Trade column/index/constraint missing or a column type differs |
| guard rejection | `3` | environment or target invalid; no connection attempted |
| connection/query failure | `1` | network, DNS, credentials, or role problem |

Prerequisite tables checked (16, i.e. every entry of `db/expected-schema.js`
except the three Live Trade tables): `kite_sessions`, `instruments`,
`daily_candles`, `scanner_configs`, `zones`, `zone_events`, `scan_jobs`,
`ingestion_checkpoints`, `aggregated_candles`, `hourly_candles`,
`four_hour_candles`, `candle_coverage`, `backfill_jobs`, `nifty500_membership`,
`hourly_ingestion_checkpoints`, `scan_job_batches`. Each must exist with every
expected column.

## 9. Step 2 — apply the migration (REQUIRES EXPLICIT APPROVAL)

Run only after §7 and after preflight exits `0` with `READY_FRESH`.

```bash
PRODUCTION_MIGRATE_ENV="$HOME/.config/demandscan/production-migrate.env" \
EXPECTED_PRODUCTION_HOST="ep-<production-id>.<region>.aws.neon.tech" \
ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION=YES \
npm run db:production:live-trade:migrate
```

What it does, in order:

1. Production guard with `write: true` (approval flag enforced).
2. Prints sanitized target metadata.
3. Runs the read-only preflight and the decision mapping:
   - `READY_FRESH` → proceed;
   - `READY_MIGRATED` → print "already applied", **write nothing**, exit `0`;
   - any `BLOCKED_*` → refuse, **write nothing**, exit `2`.
4. Re-evaluates the guard and aborts with exit `3` if the host or URL changed
   between preflight and execution.
5. Reads **only** `db/migrations/2026-11-06-add-live-trade.sql` (constant path)
   and applies its statements one at a time using the repository's existing
   `splitStatements` splitter — no new SQL parser, no `db/schema.sql`, no
   directory scan, no delegation to `db/migrate.js`.
6. On the first failing statement it stops, prints the statement number
   (`FAILED at statement N of M`), the sanitized reason, and an explicit notice
   that earlier statements may already be committed. Exit `1`.

Exit codes: `0` applied or already applied · `1` statement/unexpected failure ·
`2` preflight refused · `3` guard rejection.

## 10. Step 3 — read-only verification

```bash
PRODUCTION_MIGRATE_ENV="$HOME/.config/demandscan/production-migrate.env" \
EXPECTED_PRODUCTION_HOST="ep-<production-id>.<region>.aws.neon.tech" \
npm run db:production:live-trade:verify
```

Confirms all three Live Trade tables with their columns, column types, indexes,
primary keys, foreign keys, unique constraints and check constraints. Exit `0`
on success, `1` when anything is missing or incompatible, `3` on guard
rejection. No approval flag is required.

Optional cross-check of the whole expected schema (this uses the **existing**
`.env.local` path, unchanged):

```bash
npm run db:verify
```

Note: `db:verify` compares against `db/expected-schema.js`, which already
includes the three Live Trade tables. Until the migration is applied it reports
them as missing; after a successful apply it should pass.

## 11. After the schema exists

- The Live Trade application code is already in the repository but has not been
  committed or deployed. Deployment is a **separate, explicitly approved** step
  and is not performed by any command in this document.
- Vercel environment variables are unchanged by this procedure. The app's
  runtime connection string stays as it is; no new variable is required for the
  Live Trade tables to work.
- After deployment, verify `/live-trade` loads for a real session and that the
  board is empty for an owner with no items.

## 12. Stop conditions

Stop immediately and do not retry if any of these occur:

- Any guard rejection (exit `3`), including a hostname mismatch or an inherited
  `DATABASE_URL`.
- Preflight `BLOCKED_*` (exit `2`).
- A statement failure during apply (exit `1`) — the state is now partially
  applied by definition.
- Any error mentioning a host other than `EXPECTED_PRODUCTION_HOST`.
- Any sign that the target is not the intended production project.

Never make a failure disappear by editing the guard, the expected host, the
approval value, or the env file location. Diagnose first.

## 13. Recovery guidance

Statements run in autocommit (the same mechanism as `db/migrate.js`), so there
is **no automatic rollback**. If the apply stopped part-way:

1. Do not re-run the migrate command blindly.
2. Re-run the read-only preflight to see exactly which objects exist:
   - one or two tables present → `BLOCKED_PARTIAL`;
   - all three present but a column/index/constraint missing or a type wrong →
     `BLOCKED_INCOMPATIBLE`.
   Both states are refused by the migrate command, so a partial schema cannot be
   silently "finished" by re-running it.
3. Because every statement is `IF NOT EXISTS`, a partial state where the missing
   objects are simply absent can be completed by applying the remaining DDL — but
   only through a reviewed, explicitly approved action, not ad-hoc SQL.
4. If the partial state is wrong rather than incomplete (for example a column
   type differs), prefer restoring the §7 branch/restore point over manual
   repair, and treat that as a separate approved decision.
5. Record the sanitized error text and the statement number. Never record a
   connection string.

## 14. Known limitations (cannot be proven without a real connection)

- The preflight compares object **names**, **column types**, index names and
  constraint names. It does not verify index uniqueness, index column order,
  check-constraint expressions, or foreign-key actions. A same-named object with
  a different definition would pass preflight.
- Whether the production database is actually in `READY_FRESH` state is unknown
  until the read-only preflight is run. No assumption is made here.
- Neon role permissions (does the configured role own the schema / may it create
  tables?) can only be confirmed by running the preflight and, if approved, the
  migration.
- The `SHARE ROW EXCLUSIVE` lock on `instruments` during FK creation is standard
  Postgres behavior, but its real-world duration depends on concurrent load at
  the time of the run.
- Nothing in this document has been executed against any database.
