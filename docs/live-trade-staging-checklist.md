# Live Trade — Staging Migration Checklist

Status: prepared 2026-11-07. **Nothing in this document has been executed.**
No staging or production database has been contacted, and the migration is
still unapplied everywhere.

This checklist is the only approved sequence for the first staging run of the
Live Trade schema. It contains variable **names** and placeholders only — never
real credentials.

---

## 1. Required Neon staging project configuration

- A dedicated Neon project, separate from the production project and from any
  shared development database. Do not reuse the production project with a
  different branch unless that decision is explicitly approved.
- A region close to production (for realistic latency), default Neon Postgres
  version, and the project's default database/role.
- The project must be empty of Live Trade tables before the first run
  (`live_trade_groups`, `live_trade_items`, `live_trade_quote_state`).
- Record the **production hostname** separately. It must never appear in a
  staging env file and is supplied only as `FORBIDDEN_DATABASE_HOST`.
- No staging credential may be committed to the repository, pasted into source
  files, or added to `.env.local`.

Recommended: create a dedicated Neon branch for the first migration attempt so
the primary staging branch can be replaced if the attempt must be abandoned.

## 2. Direct and pooled connection requirements

Neon exposes two hostnames for one endpoint:

| Purpose | Host form | Used by |
|---|---|---|
| Direct (non-pooled) | `ep-<id>.<region>.aws.neon.tech` | preflight, migration, schema verification |
| Pooled | `ep-<id>-pooler.<region>.aws.neon.tech` | app runtime, integration tests |

- Both URLs must use `sslmode=require`.
- DDL must use the direct host. The guard rejects a pooled URL in migrate mode
  (`TARGET_NOT_DIRECT`).
- Runtime must use the pooled host. The guard rejects a direct URL in runtime
  mode (`TARGET_NOT_POOLED`).
- The direct host must equal `EXPECTED_STAGING_HOST` exactly (after
  lowercasing and trailing-dot removal). A different endpoint, even in the same
  project, is rejected.

## 3. Required external environment variables (names only)

Stored outside the repository, for example under the user's home directory:

| Variable | Scope | Meaning |
|---|---|---|
| `STAGING_MIGRATE_ENV` | shell | path to the direct-connection env file |
| `STAGING_RUNTIME_ENV` | shell | path to the pooled-connection env file |
| `EXPECTED_STAGING_HOST` | shell | the staging project's direct Neon hostname |
| `EXPECTED_STAGING_POOLED_HOST` | shell (optional) | only when the pooled hostname cannot be derived |
| `FORBIDDEN_DATABASE_HOST` | shell | comma-separated production hostname(s) |
| `RUN_STAGING_INTEGRATION` | shell, tests only | must be `1` |

Contents of `staging-migrate.env`:

- `DATABASE_URL` — direct Neon URL. Exactly one line.

Contents of `staging-runtime.env`:

- `DATABASE_URL` — pooled Neon URL. Exactly one line.
- `KITE_TOKEN_ENCRYPTION_KEY` — 64 hex characters, **staging-only** (never the
  production key).
- Any other Kite/app variables the app already requires, with staging values.

The guard refuses files inside the repository, a missing/duplicate
`DATABASE_URL`, an inherited conflicting `DATABASE_URL`, and identical migrate
and runtime file paths.

## 4. How to independently confirm the expected staging hostname

1. Open the Neon Console for the **staging** project.
2. Use the project's Connect panel to reveal the direct connection string.
   Inspect only the host portion (`ep-...neon.tech`); do not copy the password
   into any shell history or document.
3. Confirm the direct host matches `EXPECTED_STAGING_HOST` character for
   character.
4. Confirm the pooled host is the same hostname with `-pooler` after the
   endpoint id, unless `EXPECTED_STAGING_POOLED_HOST` is set explicitly.
5. Confirm the staging host is different from `FORBIDDEN_DATABASE_HOST`.
6. Optionally resolve the hostname (`nslookup <direct-host>`). DNS confirms the
   endpoint exists; it does **not** prove it is staging. The Neon Console is
   the authoritative source.

The guard's exact-host equality check is the final enforcement. A hostname that
does not match exactly is rejected before any connection.

## 5. Safe preflight command (read-only, no approval needed)

```bash
export STAGING_MIGRATE_ENV="$HOME/.config/demandscan/staging-migrate.env"
export EXPECTED_STAGING_HOST="ep-<staging-id>.<region>.aws.neon.tech"
export FORBIDDEN_DATABASE_HOST="<production-host>"

npm run db:staging:preflight
```

This opens a read-only connection and queries `information_schema`/`pg_catalog`
only. It prints sanitized target metadata (host, database, sslmode, pooled) and
never the URL.

Expected result:

- `READY_FRESH` — prerequisites present, no Live Trade tables.
- `READY_MIGRATED` — prerequisites and every Live Trade column/index/constraint
  present.
- Exit code `0` only for those two states.
- `BLOCKED_PREREQUISITES`, `BLOCKED_PARTIAL`, `BLOCKED_INCOMPATIBLE` exit `2`.
- Guard rejection exits `3`; a connection/query failure exits `1`.

## 6. Safe migration command — REQUIRES EXPLICIT APPROVAL

Do not run this until preflight exits `0` and the approval is recorded.

```bash
npm run db:staging:migrate
```

What it does:

1. Re-runs the staging guard (direct host, expected host, forbidden host, no
   ambiguous URL).
2. Re-runs the read-only preflight.
3. **Refuses with exit `2` and applies nothing** unless preflight is
   `READY_FRESH` or `READY_MIGRATED`.
4. Only then delegates to the unmodified `db/migrate.js` with the validated URL
   injected for the child process.

## 7. Safe staging verification command (read-only)

```bash
npm run db:staging:verify
```

Uses the same staging guard as preflight/migration (migrate mode, direct host),
then runs the same `information_schema` column check as `db:verify`. It never
prints the URL.

Expected result:

- Exit `0` and `Staging schema verification passed.`
- Exit `1` with missing table/column lines if the schema is incomplete.
- Exit `3` if the guard rejects the environment — no connection is attempted.

## 8. Real-Neon integration test command — REQUIRES EXPLICIT APPROVAL

```bash
export STAGING_RUNTIME_ENV="$HOME/.config/demandscan/staging-runtime.env"
export EXPECTED_STAGING_HOST="ep-<staging-id>.<region>.aws.neon.tech"
export FORBIDDEN_DATABASE_HOST="<production-host>"
export RUN_STAGING_INTEGRATION=1

npm run test:staging
```

Notes:

- The suite uses the pooled staging URL, real repository/service/route code and
  the real Neon HTTP driver.
- All fixtures use `ZZTEST`-prefixed symbols, reserved synthetic instrument ids,
  run-scoped `zztest-` owners and a per-run UUID. Cleanup deletes only those
  rows; it never truncates.
- The external Kite client is mocked to throw; no real Kite token is used.
- The default `npm test` suite never discovers these tests.
- If any guard check fails, the suite aborts before loading the application
  database client.

## 9. Staging app launch command

```bash
npm run dev:staging
# or, after a production-style build:
npm run build
npm run start:staging
```

The launcher validates the runtime guard, merges the staging file's values into
the child environment, and unsets `DB_ENV_FILE`. Verify `/live-trade` loads with
a staging login and that the board is empty for a fresh staging owner.

## 10. Expected outcomes and stop conditions

Proceed only when all of the following hold:

- Preflight exits `0` (`READY_FRESH`, then `READY_MIGRATED` after migration).
- `db:staging:verify` exits `0`.
- `npm run test:staging` passes with exit `0`.
- The staging app loads `/live-trade` without 500 responses.

Stop immediately if any of these occur:

- Any guard rejection (exit `3`): host mismatch, forbidden host, pooled/direct
  mismatch, missing env file, or ambiguous `DATABASE_URL`.
- Preflight `BLOCKED_*` (exit `2`).
- Any verification failure (exit `1`).
- A connection error mentioning a host other than the expected staging host.
- Any request that appears to target production.

Do not retry by editing the guard, the expected host, or the forbidden host to
make a failure disappear. Diagnose the environment instead.

## 11. Recovery guidance if migration fails

The runner applies statements individually (autocommit) and has no migration
ledger. It is idempotent through `IF NOT EXISTS`, but a failure can leave a
partially created schema group.

1. Do not re-run blindly.
2. Re-run `npm run db:staging:preflight`. A partially created Live Trade set
   reports `BLOCKED_PARTIAL`; missing indexes/constraints report
   `BLOCKED_INCOMPATIBLE`. The migration wrapper refuses in both states.
3. Capture the sanitized error and the last `Applying migration ...` line.
   Never copy a connection string into a ticket or chat.
4. Because the schema is new and staging-only, the cleanest recovery is the
   staging Neon branch: restore/replace the branch from before the attempt
   (Neon Console branch restore), then re-run preflight and the approved
   migration. This requires explicit approval.
5. Manual DDL repair in staging is a last resort and requires explicit
   approval plus a reviewed script. Never run ad-hoc DDL against production.
6. If the failure is a connection/permission error, fix the staging role or URL
   in the external file; do not modify the guard to bypass it.

## 12. Production remains untouched

Until a separate, explicit production activation phase:

- No staging command reads `.env.local`, `DB_ENV_FILE`, or an inherited
  `DATABASE_URL`.
- The production hostname is configured only as `FORBIDDEN_DATABASE_HOST` and
  is rejected by exact match and by the derived direct/pooled pair.
- `db/migrate.js` and `db/verify-schema.js` behavior is unchanged; staging
  uses separate wrappers.
- No migration, deployment, commit, push, or production write has occurred.
- Production credentials and secrets have not been read, printed, or modified.
