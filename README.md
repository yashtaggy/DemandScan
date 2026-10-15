# DemandScan — Personal NSE Stock Scanner

A functional NSE stock market scanner built on **Next.js 16**, **TypeScript**, and **Zerodha Kite Connect**. DemandScan is a read-only market-data application — it displays live Nifty 500 quotes and is designed as a personal tool for the account owner.

> **⚠️ Legal notice:** This application is for the account owner's personal use only. It does not redistribute exchange data, implement trading, or claim to reproduce any third-party scanner's proprietary methodology.

---

## Features (Phase 1 — MVP)

| Feature | Status |
|---|---|
| Zerodha Kite Connect OAuth login | ✅ |
| Secure server-side session (never touches browser) | ✅ |
| Per-browser session isolation (HttpOnly cookie + DB) | ✅ |
| AES-256-GCM encrypted access token at rest | ✅ |
| NSE instrument master loading + caching | ✅ |
| Nifty 500 batch quote retrieval | ✅ |
| Dark-theme responsive dashboard | ✅ |
| Symbol/name search | ✅ |
| Sort by price, change %, volume | ✅ |
| Gainers / Losers filter | ✅ |
| Minimum % change filter | ✅ |
| Configurable auto-refresh (30s / 1m / 5m) | ✅ |
| Market status indicator (NSE hours) | ✅ |
| Indian number formatting (L, Cr) | ✅ |
| Supply/demand zone detection | 🔜 Phase 2 |
| Multi-timeframe scanning | 🔜 Phase 2 |
| WebSocket tick streaming | 🔜 Phase 2 |

---

## Prerequisites

- **Node.js** ≥ 20.x
- **npm** ≥ 10.x
- A **Zerodha Kite Connect** developer account and app — https://developers.kite.trade/
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
# Then edit .env.local with your credentials (see below)

# Run the database migration (one-time)
node db/migrate.js
```

---

## Environment Variables

Create `.env.local` from `.env.example`. **Never commit this file.**

### Required for all environments

| Variable | Description |
|---|---|
| `KITE_API_KEY` | From https://developers.kite.trade/apps |
| `KITE_API_SECRET` | From https://developers.kite.trade/apps |
| `KITE_REDIRECT_URL` | Callback URL — must match Kite developer console exactly |
| `KITE_TOKEN_ENCRYPTION_KEY` | 64-hex-char (32-byte) AES-256 key — see generation below |
| `DATABASE_URL` | Neon Postgres connection string — see setup below |

### Optional

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Your deployed app URL (e.g. `https://demandscan.vercel.app`). Recommended for production to ensure correct OAuth redirect origin. |

### Generating secrets

```bash
# KITE_TOKEN_ENCRYPTION_KEY (64-hex AES-256 key)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Database Setup (Neon Postgres)

1. Go to https://neon.tech and create a free account
2. Create a new **project** (region: Asia / Singapore for lowest latency)
3. From the project dashboard, copy the **Connection string** (looks like `postgres://...`)
4. Paste it as `DATABASE_URL` in `.env.local`
5. Run the migration:
   ```bash
   node db/migrate.js
   ```
   This creates the `kite_sessions` table. The script is **idempotent** — safe to run multiple times, no data is deleted.

The schema is in [`db/schema.sql`](db/schema.sql).

---

## Kite Developer Console Setup

1. Log in at https://developers.kite.trade/apps
2. Create a new app (type: **Connect**)
3. Set **Redirect URL** to exactly:
   - **Local**: `http://localhost:3000/api/kite/callback`
   - **Production**: `https://your-domain.vercel.app/api/kite/callback`
4. Note your **API Key** and **API Secret**
5. Copy them into `.env.local`

> **Important:** The redirect URL in your Kite app console must match `KITE_REDIRECT_URL` in your environment variables exactly. Any difference (trailing slash, http vs https) will cause the callback to fail.

---

## Starting the Development Server

```bash
npm run dev
```

Then open http://localhost:3000 in your browser.

---

## Authentication Flow

1. Click **"Connect with Zerodha"** on the dashboard
2. You are redirected to Zerodha's login page
3. After login, Zerodha redirects to `/api/kite/callback?request_token=...`
4. The server exchanges the `request_token` for an `access_token` using the Kite SDK
5. The `access_token` is **AES-256-GCM encrypted** and stored in Neon Postgres
6. A cryptographically random, opaque session ID is issued in an **HttpOnly cookie** (`ds_sid`)
7. Only the SHA-256 hash of the session ID is stored in the database
8. Every subsequent request resolves the session from the cookie → database → decrypted token
9. The `access_token` is **never sent to the browser**

To disconnect, click **"Disconnect"** in the header. The database row is deleted and the cookie is cleared.

### Session Security Properties

| Property | Implementation |
|---|---|
| Cookie is HttpOnly | ✅ — JS cannot read it |
| Cookie is Secure in production | ✅ — HTTPS only |
| Cookie is SameSite=Lax | ✅ — CSRF protection |
| Token encrypted at rest | ✅ — AES-256-GCM |
| Session ID hashed in DB | ✅ — SHA-256 |
| Per-browser isolation | ✅ — each browser gets its own row |
| No token in localStorage | ✅ |
| No token in URL | ✅ |

### Session Expiry

Kite access tokens expire at **06:00 IST** on the next calendar day (regulatory requirement). When your session expires, the dashboard shows "Not connected" and prompts you to reconnect.

---

## Vercel Deployment

### Step 1 — Set environment variables in Vercel

Go to your Vercel project → **Settings → Environment Variables** and add:

| Name | Value | Environments |
|---|---|---|
| `KITE_API_KEY` | Your Kite API key | Production, Preview |
| `KITE_API_SECRET` | Your Kite API secret | Production, Preview |
| `KITE_REDIRECT_URL` | `https://your-domain.vercel.app/api/kite/callback` | Production |
| `KITE_TOKEN_ENCRYPTION_KEY` | 64-hex-char key (generate fresh for production) | Production, Preview |
| `DATABASE_URL` | Neon connection string | Production, Preview |
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.vercel.app` | Production |

### Step 2 — Update Kite developer console

In your Kite app settings, **add** your production callback URL:
```
https://your-domain.vercel.app/api/kite/callback
```

### Step 3 — Run the database migration against production

```bash
# With the production DATABASE_URL set in your shell:
DATABASE_URL="postgres://..." node db/migrate.js
```

Or run it locally with the production URL — the schema is idempotent.

### Step 4 — Redeploy

Push a new commit or trigger a manual redeploy in Vercel.

---

## Running Tests

Tests use Jest with mocked database and Kite SDK. **No real credentials required.**

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

### Test coverage

| Test file | What it covers |
|---|---|
| `__tests__/kite-session.test.ts` | DB session store, cookie parsing, auth helpers, cookie security attributes, expiry handling |
| `__tests__/kite-client.test.ts` | Quote calculation, market status |
| `__tests__/utils.test.ts` | INR formatting, volume, % change |
| `__tests__/nifty500.test.ts` | Constituent list deduplication, format |

---

## Type Checking

```bash
npm run typecheck
```

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/kite/login` | GET | Redirects to Zerodha login |
| `/api/kite/callback` | GET | Handles OAuth callback, issues session cookie |
| `/api/kite/status` | GET | Returns auth status (no secrets) |
| `/api/kite/logout` | POST | Clears session cookie and invalidates DB row |
| `/api/kite/quote?symbol=NSE:INFY` | GET | Single instrument quote |
| `/api/stocks` | GET | Nifty 500 with filters/sort/pagination |
| `/api/stocks/[symbol]` | GET | Single stock detail |

All responses are clean JSON — never raw Kite responses, stack traces, or credentials.

---

## Known Limitations

1. **REST polling, not WebSocket streaming** — quotes are fetched on demand or at the configured interval. This is not real-time tick-by-tick data.
2. **Nifty 500 constituent list** — curated manually. Update `lib/nifty500.ts` after each quarterly NSE reconstitution (March, June, September, December).
3. **Market holidays** — the market-open indicator uses clock time only. It does not account for NSE trading holidays.
4. **Single-user design** — one Zerodha account per deployment. Each browser session is isolated but they all share the same Kite credentials.
5. **Kite API rate limits** — the `/api/stocks` route fetches up to 500 symbols in a single batch call (Kite's documented limit). Do not set the refresh interval below 30 seconds.

---

## Security Notes

- API key, API secret, and access token are **never** sent to the browser
- Access token is **AES-256-GCM encrypted** in the database; only its encrypted form is stored
- Only the **SHA-256 hash** of the session cookie ID is stored in the database
- `KITE_TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` are **server-only** variables (no `NEXT_PUBLIC_` prefix)
- Callback URL is secured with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
- All redirects from the callback are pinned to the configured app origin (no open redirect)
- Errors returned to the browser are generic — internal details are server-log only
- `.env.local` is in `.gitignore`; only `.env.example` (with empty values) is committed

---

## Phase 2 — Supply/Demand Zone Scanner (Planned)

The `ScannerPanel` component on the dashboard shows the planned Phase 2 controls. When Phase 2 begins:

- Historical candle data will be fetched from Kite's authorized `/instruments/historical` endpoint
- Supply and demand zone detection will be implemented as pure TypeScript functions in `lib/scanner/`
- No calculation code will be inside React components
- Calculations will be testable with sample datasets without real credentials

---

## License

Private / personal use. Not for redistribution.
