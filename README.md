# DemandScan — Personal NSE Supply/Demand Zone Scanner

A personal NSE stock scanner built on **Next.js 16**, **TypeScript**, and
**Zerodha Kite Connect**. DemandScan detects multi-timeframe supply and demand
zones across the Nifty 500 universe, scores them for quality, tracks their
lifecycle, and computes cross-timeframe confluence and opposing-zone risk.

> **⚠️ Legal notice:** This application is for the account owner's personal
> use only. It does not redistribute exchange data, implement trading, or claim
> to reproduce any third-party scanner's proprietary methodology.

---

## Feature Status

| Feature | Status |
|---|---|
| Zerodha Kite Connect OAuth login | ✅ |
| Secure server-side session (never touches browser) | ✅ |
| Per-browser session isolation (HttpOnly cookie + DB) | ✅ |
| AES-256-GCM encrypted access token at rest | ✅ |
| NSE instrument master loading + caching | ✅ |
| Nifty 500 batch quote retrieval | ✅ |
| Dark-theme responsive dashboard | ✅ |
| Symbol / name search, sort, filter | ✅ |
| Configurable auto-refresh | ✅ |
| Market status indicator | ✅ |
| **Instrument master sync from Kite** | ✅ Phase 2 |
| **Incremental daily OHLCV candle ingestion** | ✅ Phase 2 |
| **Multi-timeframe aggregation (1W/1M/3M/6M/1Y)** | ✅ Phase 3 |
| **Pattern detection (DBR/RBR/RBD/DBD)** | ✅ Phase 4 |
| **Zone boundaries + 0–100 strength scoring** | ✅ Phase 5 |
| **Zone lifecycle state-machine + event log** | ✅ Phase 6 |
| **Cross-timeframe confluence scoring** | ✅ Phase 7 |
| **Opposing-zone risk metrics** | ✅ Phase 7 |
| **Scanner REST API** | ✅ Phase 8 |
| **Scanner UI: controls, progress, zone table, drawer** | ✅ Phase 9 |
| **CSV / JSON export** | ✅ |
| **Unit + integration test suite (242 tests)** | ✅ Phase 10 |

---

## Prerequisites

- **Node.js** ≥ 20.x
- **npm** ≥ 10.x
- A **Zerodha Kite Connect** developer account — https://developers.kite.trade/
- A **Neon Postgres** database — https://neon.tech (free tier is sufficient)

---

## Installation

```bash
# Clone or unzip the project
cd "d:/Scanner Build"

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your credentials (see Environment Variables below)

# Run all database migrations (one-time setup, idempotent)
node db/migrate.js

# Verify the live database matches the schema the code expects (read-only)
node db/verify-schema.js
```

---

## Environment Variables

Create `.env.local` from `.env.example`. **Never commit this file.**

| Variable | Description |
|---|---|
| `KITE_API_KEY` | From https://developers.kite.trade/apps |
| `KITE_API_SECRET` | From https://developers.kite.trade/apps |
| `KITE_REDIRECT_URL` | OAuth callback — must match Kite developer console exactly |
| `KITE_TOKEN_ENCRYPTION_KEY` | 64-hex-char (32-byte) AES-256 key — see generation below |
| `DATABASE_URL` | Neon Postgres connection string |
| `NEXT_PUBLIC_APP_URL` | *(Optional)* Deployed app URL — recommended for production |

### Generating secrets

```bash
# KITE_TOKEN_ENCRYPTION_KEY (64-hex AES-256 key)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Database Setup

1. Go to https://neon.tech → create a free project (choose Asia/Singapore region)
2. Copy the **Connection string** from the project dashboard
3. Paste as `DATABASE_URL` in `.env.local`
4. Confirm which target is configured (host and database only — credentials are
   never printed):
   ```bash
   npm run db:target
   ```
   To check a production target without touching `.env.local`:
   ```bash
   DB_ENV_FILE=.env.production.local npm run db:target
   ```
5. Run migrations:
   ```bash
   node db/migrate.js
   ```
   The script is **idempotent** — safe to run multiple times, no data is deleted.
6. Verify the live schema matches what the code expects:
   ```bash
   node db/verify-schema.js
   ```
   This is a **read-only** check. Run it after every migration and against
   production before deploying — a migration committed to the repo but never
   applied to the live database causes `NeonDbError: column ... does not exist`
   (HTTP 500) at runtime, which local tests cannot catch. `db:target` identifies
   the configured host/database; it does **not** prove that Vercel Production
   uses that same database.

### Schema summary

| Table | Purpose |
|---|---|
| `kite_sessions` | Encrypted Kite access tokens, keyed by hashed session cookie |
| `instruments` | NSE instrument master (synced from Kite) |
| `daily_candles` | Raw OHLCV daily candles (Phase 2) |
| `aggregated_candles` | Weekly/monthly aggregated candles (Phase 3) |
| `zones` | Detected supply/demand zones with scores + lifecycle state |
| `zone_events` | Immutable audit log of zone TOUCH / RETEST / BREAK events |
| `scan_jobs` | Job records with status, progress, session ownership, and resumable batch checkpoints |
| `scan_job_batches` | Per-batch checkpoint/audit rows for the browser-driven scan worker |
| `scanner_configs` | Versioned scanner configuration snapshots |
| `ingestion_checkpoints` | Per-instrument last-ingested date for incremental fetches |

---

## Kite Developer Console Setup

1. Log in at https://developers.kite.trade/apps → create a **Connect** app
2. Set **Redirect URL**:
   - Local: `http://localhost:3000/api/kite/callback`
   - Production: `https://your-domain.vercel.app/api/kite/callback`
3. Note your **API Key** and **API Secret** → paste into `.env.local`

> **Important:** The redirect URL in Kite must match `KITE_REDIRECT_URL` exactly
> (including protocol and no trailing slash).

---

## Starting the Development Server

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

---

## Running a Full Scan

### Option A — Through the UI

1. Connect with Zerodha on the dashboard
2. Navigate to **Scanner** (top-nav or `/scanner`)
3. Set your desired filters (timeframe, zone side, min score)
4. Click **Run Full Scan** — the job is queued and progress is shown live

### Option B — Via REST API

```bash
# Authenticate first (cookie required); use a tool like curl with a valid ds_sid cookie.

# Step 1: Sync instruments + ingest candles (Phase 2)
curl -X POST http://localhost:3000/api/scanner/ingest \
  -H "Cookie: ds_sid=<your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"from":"2023-01-01","to":"2024-10-18","concurrency":5}'

# Step 2: Aggregate candles into higher timeframes (Phase 3)
curl -X POST http://localhost:3000/api/scanner/aggregate \
  -H "Cookie: ds_sid=<your-session-cookie>"

# Step 3: Run full scan (phases 4-6: pattern detection, zone scoring, lifecycle)
curl -X POST http://localhost:3000/api/scanner/run \
  -H "Cookie: ds_sid=<your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"from":"2023-01-01","to":"2024-10-18"}'

# Step 4: Check job status
curl http://localhost:3000/api/scanner/job/<jobId> \
  -H "Cookie: ds_sid=<your-session-cookie>"
```

---

## API Reference

### Authentication

| Endpoint | Method | Description |
|---|---|---|
| `/api/kite/login` | GET | Redirects to Zerodha login |
| `/api/kite/callback` | GET | Handles OAuth callback, issues session cookie |
| `/api/kite/status` | GET | Returns auth status (no secrets) |
| `/api/kite/logout` | POST | Clears session and deletes DB row |

### Market Data

| Endpoint | Method | Description |
|---|---|---|
| `/api/stocks` | GET | Nifty 500 quotes with filtering, sorting, pagination |
| `/api/stocks/[symbol]` | GET | Single stock detail |
| `/api/kite/quote?symbol=NSE:INFY` | GET | Live quote for one symbol |

### Scanner Pipeline

| Endpoint | Method | Description |
|---|---|---|
| `/api/scanner/ingest` | POST | Phase 2: sync instruments + ingest daily candles |
| `/api/scanner/aggregate` | POST | Phase 3: aggregate daily → weekly/monthly/etc. candles |
| `/api/scanner/run` | POST | Phases 4–6: full pattern detection + zone scoring + lifecycle |
| `/api/scanner/batch` | POST | Browser-driven worker: processes one bounded batch of the active job |
| `/api/scanner/job/[jobId]` | GET | Job status and progress percentage |
| `/api/scanner/zones` | GET | Query detected zones with filters |
| `/api/scanner/confluence` | GET | Phase 7: confluence score + opposition risk per zone |
| `/api/scanner/export` | GET | Download zones as CSV or JSON |

#### `/api/scanner/ingest` body params

| Param | Type | Default | Description |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | 1 year back | Candle history start date |
| `to` | `YYYY-MM-DD` | today | Candle history end date |
| `concurrency` | number | `5` | Parallel Kite requests |

#### `/api/scanner/zones` query params

| Param | Type | Description |
|---|---|---|
| `instrumentId` | number | Filter by instrument token |
| `symbol` | string | Filter by NSE trading symbol (case-insensitive) |
| `timeframe` | `1H\|4H\|1D\|1W\|1M\|3M\|6M\|1Y` | Filter by timeframe |
| `side` | `DEMAND\|SUPPLY` | Filter by zone side |
| `pattern` | `DBR\|RBR\|RBD\|DBD` | Filter by base pattern |
| `lifecycle` | `CONFIRMED_FRESH\|TOUCHED_ONCE\|RETESTED\|BROKEN` | Filter by lifecycle state |
| `minScore` | number | Minimum zone score (0–100) |
| `minCompositeScore` | number | Minimum composite score (0–100) |
| `minConfluence` | number | Minimum confluence score (0–100) |
| `maxOppositionRisk` | number | Maximum opposition risk (0–100) |
| `maxDistancePct` | number | Maximum distance from current price, percent |
| `formationFrom` / `formationTo` | `YYYY-MM-DD` | Formation date range |
| `sort` | `composite_score\|score\|formation_ts\|distance_pct` | Sort column (default `composite_score`) |
| `dir` | `asc\|desc` | Sort direction (default `desc`) |
| `limit` | number | Max results (default 100, max 500) |
| `offset` | number | Pagination offset (default 0) |

Invalid values return `400` with a specific error instead of being silently coerced.

#### `/api/scanner/confluence` query params

| Param | Type | Description |
|---|---|---|
| `zoneId` | string (UUID) | Compute for a specific zone |
| `instrumentId` | number | Compute for all active zones of an instrument |

#### `/api/scanner/export` query params

Same filter params as `/api/scanner/zones`. Add the `Accept` header to control format:
- `Accept: text/csv` → downloads a `.csv` file
- `Accept: application/json` → returns JSON (default)

---

## Zone Scoring Rubric (0–100)

| Component | Max Points | Description |
|---|---|---|
| Timeframe quality | 30 | 1Y=30, 6M=25, 3M=20, 1M=15, 1W=10, 1D=5 |
| Leg-out strength | 20 | Body/range ratio of the leg-out candle |
| Base tightness | 20 | Lower body/range → tighter base → higher score |
| Volume surge | 10 | Leg-out volume vs 20-candle average |
| Fresh zone bonus | 20 | Applied while lifecycle = CONFIRMED_FRESH |

---

## Confluence Scoring (Phase 7)

**Confluence** measures how many higher-timeframe same-side zones contain a given zone.
Each containing zone contributes its timeframe weight (same scale as zone scoring).
Capped at 100.

**Opposition risk** (0–100) measures nearby opposing zones in the trade direction
within 20 % of the zone's proximal level. Higher = more likely price will reverse
before reaching target.

---

## Zone Lifecycle State Machine

```
CONFIRMED_FRESH
     │
     ├─ price touches proximal ──► TOUCHED_ONCE
     │                                   │
     │                                   ├─ price touches again ──► RETESTED
     │                                   │
     │                                   └─ price closes beyond distal ──► BROKEN
     │
     └─ price closes beyond distal ──► BROKEN
```

> **Policy:** If a candle both touches and breaks on the same bar, BREAK takes
> priority. The BREAK event is recorded and the touch count is NOT incremented.

---

## Running Tests

```bash
# All tests (no real credentials needed — DB and Kite SDK are mocked)
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

### Test coverage

| Test file | Coverage |
|---|---|
| `__tests__/kite-session.test.ts` | Session store, cookie security, expiry |
| `__tests__/kite-client.test.ts` | Quote calculation, market status |
| `__tests__/utils.test.ts` | INR formatting, volume, % change |
| `__tests__/nifty500.test.ts` | Constituent list deduplication |
| `__tests__/scanner/patterns.test.ts` | DBR/RBR/RBD/DBD pattern detection |
| `__tests__/scanner/zones.test.ts` | Zone scoring, upsert logic |
| `__tests__/scanner/confluence.test.ts` | Confluence scoring, opposition risk |
| `lib/scanner/__tests__/export.test.ts` | CSV serialisation |

---

## Type Checking

```bash
npm run typecheck
```

---

## Vercel Deployment

### Step 1 — Set environment variables

Go to **Vercel project → Settings → Environment Variables** and add all vars
from the [Environment Variables](#environment-variables) section above.

Set `KITE_REDIRECT_URL` to:
```
https://your-domain.vercel.app/api/kite/callback
```

### Step 2 — Update Kite developer console

Add the production callback URL in your Kite app settings:
```
https://your-domain.vercel.app/api/kite/callback
```

### Step 3 — Run migrations against the production DB

Migrations are **not** run by the Vercel build. After pulling (or writing) a
commit that adds a file under `db/migrations/`, apply it to the production
database manually:

```bash
DB_ENV_FILE=.env.production.local npm run db:target
DB_ENV_FILE=.env.production.local node db/migrate.js
```

Then confirm the production schema actually has the new objects (read-only):

```bash
DB_ENV_FILE=.env.production.local node db/verify-schema.js
```

`.env.production.local` is git-ignored and must contain the Vercel Production
`DATABASE_URL`. Confirm the printed host/database is the intended Neon project
before applying anything. Until `verify-schema.js` passes, endpoints that rely
on new columns or tables will fail with HTTP 500 in production regardless of
local test results.

### Step 4 — Verify build

```bash
npm run typecheck && npm test && npm run build
```

All three must pass before deploying.

### Step 5 — Redeploy

Push a new commit or trigger a manual redeploy in Vercel.

> **Vercel execution model:** There is no cron. `POST /api/scanner/run` creates
> a resumable job, processes the first bounded batch, and returns a `jobId`.
> The authenticated browser then calls `POST /api/scanner/batch` repeatedly;
> each call has a 60-second `maxDuration` and persists its checkpoint.
> Progress pauses when the tab is closed. Reopening the scanner resumes the
> same persisted job — it never creates a duplicate. A full Nifty 500 scan
> spans hundreds of batches and can take a long time; the UI shows persisted
> progress and per-batch timing. Do not deploy a new full-scan design without a
> measured authenticated run.

---

## Authentication Flow

1. Click **"Connect with Zerodha"** on the dashboard
2. Zerodha redirects to `/api/kite/callback?request_token=...`
3. Server exchanges the token for an `access_token` via Kite SDK
4. The `access_token` is **AES-256-GCM encrypted** and stored in Neon Postgres
5. A cryptographically random, opaque session ID is issued as an **HttpOnly cookie** (`ds_sid`)
6. Only the **SHA-256 hash** of the session ID is stored in the database
7. Every subsequent request resolves: cookie → hash → DB lookup → decrypted token
8. The `access_token` is **never sent to the browser**
9. To disconnect: click **Disconnect** — the DB row is deleted and cookie cleared

---

## Known Limitations

1. **REST polling, not WebSocket tick streaming** — quotes refresh on demand or
   at the configured interval. Not real-time tick-by-tick.
2. **Nifty 500 constituent list** — a curated snapshot of the official NSE
   `ind_nifty500list.csv` (source URL and retrieval date are recorded in
   `lib/nifty500.ts`; the raw CSV is kept under `data/nifty500/`). Seeding into
   `nifty500_membership` is strict: missing, inactive, or ambiguous mappings
   abort before any membership row changes, and resolution never falls back to
   the full instrument master. Refresh the snapshot and reconcile it against
   the active Kite master after each quarterly reconstitution (March, June,
   September, December) or any ad-hoc index change.
3. **Market holidays** — the market-open indicator uses clock time only; NSE
   trading holidays are not accounted for.
4. **Single-user design** — one Zerodha account per deployment.
5. **Kite API rate limits** — the candle ingestion uses exponential back-off on
   HTTP 429. Keep `concurrency` ≤ 5 for safety.
6. **Vercel execution limits / browser-driven progress** — a scan is a
   persisted job advanced one bounded batch per serverless invocation
   (60-second `maxDuration`). The authenticated browser calls
   `POST /api/scanner/batch` repeatedly; closing the tab pauses progress and
   reopening the scanner resumes the same job. A full Nifty 500 scan spans
   hundreds of batches, so wall-clock duration depends on how long the tab
   stays open. There is no cron and no background continuation after the tab
   closes.

---

## Security Notes

- API key, API secret, and access token are **never** sent to the browser
- Access token is **AES-256-GCM encrypted** in the database
- Only the **SHA-256 hash** of the session cookie ID is stored
- `KITE_TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` have **no** `NEXT_PUBLIC_` prefix
- Callback URL is secured with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
- Errors returned to the browser are generic — internal details are server-log only
- `.env.local` is in `.gitignore`; only `.env.example` (with empty values) is committed

---

## License

Private / personal use. Not for redistribution.
