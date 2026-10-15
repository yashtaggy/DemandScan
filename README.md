# DemandScan — Personal NSE Stock Scanner

A functional, locally-runnable NSE stock market scanner built on **Next.js 16**, **TypeScript**, and **Zerodha Kite Connect**. DemandScan is a read-only market-data application — it displays live Nifty 500 quotes and is designed as a personal tool for the account owner.

> **⚠️ Legal notice:** This application is for the account owner's personal use only. It does not redistribute exchange data, implement trading, or claim to reproduce any third-party scanner's proprietary methodology.

---

## Features (Phase 1 — MVP)

| Feature | Status |
|---|---|
| Zerodha Kite Connect OAuth login | ✅ |
| Secure server-side session (never touches browser) | ✅ |
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
```

---

## Environment Variables

Create `.env.local` from `.env.example`. Never commit this file.

```
KITE_API_KEY=your_api_key_here
KITE_API_SECRET=your_api_secret_here
KITE_REDIRECT_URL=http://localhost:3000/api/kite/callback
SESSION_SECRET=any_long_random_string_here
```

> `SESSION_SECRET` is not used by the current in-memory session store but is reserved for the future encrypted-session implementation.

---

## Kite Developer Console Setup

1. Log in at https://developers.kite.trade/apps
2. Create a new app (type: **Connect**)
3. Set **Redirect URL** to exactly: `http://localhost:3000/api/kite/callback`
4. Note your **API Key** and **API Secret**
5. Copy them into `.env.local`

> **Important:** The redirect URL in your Kite app console must match `KITE_REDIRECT_URL` in `.env.local` exactly. A trailing slash, `https://`, or any difference will cause the callback to fail.

---

## Starting the Development Server

```bash
npm run dev
```

Then open http://localhost:3000 in your browser.

---

## Authentication Flow

1. Click **"Connect with Zerodha"** on the dashboard
2. You are redirected to Zerodha's login page (https://kite.zerodha.com)
3. After login, Zerodha redirects to `/api/kite/callback?request_token=...`
4. The server exchanges the `request_token` for an `access_token` using the Kite SDK
5. The `access_token` is stored **server-side only** — never sent to the browser
6. You are redirected back to the dashboard with an active session

To disconnect, click **"Disconnect"** in the header. The server-side session is cleared and Kite's token is invalidated.

### Session Expiry

Kite access tokens expire at **06:00 IST** on the next calendar day (regulatory requirement). When your session expires, the dashboard will show "Not connected" and prompt you to reconnect.

---

## Testing a Quote

After connecting, you can test a raw quote via:

```
GET http://localhost:3000/api/kite/quote?symbol=NSE:INFY
```

Or use the dashboard search to find and view any Nifty 500 stock.

---

## Running Tests

Tests use Jest with mocked market-data. **No real Kite credentials are required.**

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
| `__tests__/kite-session.test.ts` | Session store, expiry, auth checks |
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
| `/api/kite/callback` | GET | Handles OAuth callback |
| `/api/kite/status` | GET | Returns auth status (no secrets) |
| `/api/kite/logout` | POST | Clears session |
| `/api/kite/quote?symbol=NSE:INFY` | GET | Single instrument quote |
| `/api/stocks` | GET | Nifty 500 with filters/sort/pagination |
| `/api/stocks/[symbol]` | GET | Single stock detail |

All responses are clean JSON — never raw Kite responses, stack traces, or credentials.

---

## Known Limitations

1. **In-memory sessions** — the session is lost when the server restarts. See `lib/kite-session.ts` for the production upgrade path.
2. **REST polling, not WebSocket streaming** — quotes are fetched on demand or at the configured interval. This is not real-time tick-by-tick data.
3. **Nifty 500 constituent list** — curated manually. Update `lib/nifty500.ts` after each quarterly NSE reconstitution (March, June, September, December).
4. **Market holidays** — the market-open indicator uses clock time only. It does not account for NSE trading holidays.
5. **Single-user only** — the session store is designed for one user. Do not deploy to a shared environment without implementing proper multi-user session storage.
6. **Kite API rate limits** — the `/api/stocks` route fetches up to 500 symbols in a single batch call (Kite's documented limit). Do not set the refresh interval below 30 seconds.

---

## Deployment Checklist (Future)

Before deploying beyond localhost:

- [ ] Replace `InMemorySessionStore` in `lib/kite-session.ts` with an encrypted persistent store (Redis + AES-256 or database + pgcrypto)
- [ ] Generate a strong `SESSION_SECRET` (`openssl rand -hex 32`)
- [ ] Update `KITE_REDIRECT_URL` to your production domain and register it in the Kite developer console
- [ ] Review Zerodha's data redistribution terms before allowing multiple users
- [ ] Enable HTTPS
- [ ] Set `NODE_ENV=production`
- [ ] Run `npm run build && npm run start`

---

## Security Notes

- API key, API secret, and access token are **never** sent to the browser
- Callback URL is secured with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
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
