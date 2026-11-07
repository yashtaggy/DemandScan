# Live Trade API (Phase 5)

HTTP backend for the Live Trade workspace. Phase 5 adds a batched market
snapshot (`/quotes`), demand/supply zone summaries and nearest-zone distances
(`/zones`, and a `zones` section on the board). It still does **not** provide
scanner jobs, P&L, orders, a streaming feed or AI output.

All endpoints are under `/api/live-trade`.

## Authentication and ownership

- Every endpoint requires the existing Kite session cookie (`ds_sid`, HttpOnly).
- The owner is resolved **only** from the server-side session through
  `resolveLiveTradeOwner` in `lib/live-trade/ownership.ts`.
- Owner identifiers in a request body, query string or header are ignored.
  Body fields such as `ownerUserId`, `ownerId`, `itemId`, `sortOrder` and
  `version` (where server-controlled) are rejected with `INVALID_BODY`.
- Missing, expired, malformed or blank owner sessions return `401
  UNAUTHENTICATED`.
- A session-store/database failure is a `500 INTERNAL`, never a misleading
  authentication failure.
- Repository statements are always scoped by `owner_user_id`. Foreign IDs are
  indistinguishable from missing ones and return `404 NOT_FOUND`; a malformed
  path UUID is rejected before any lookup with `400 INVALID_QUERY`.

## Mutation protection (Origin check)

`POST`, `PATCH` and `DELETE` require an `Origin` header that matches one of:

1. The configured application origin (`NEXT_PUBLIC_APP_URL`, falling back to
   the origin of `KITE_REDIRECT_URL`).
2. Outside production only, the loopback origin the request was addressed to
   (`http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`).

Missing, malformed or unexpected origins return `403 FORBIDDEN`. There is no
wildcard origin and no forwarded-host trust. The Origin check runs before
session lookup, so a rejected request performs no authentication or database
work. `GET` endpoints do not require an Origin header. They never mutate
workspace data; `/api/live-trade/quotes` records only short-lived per-owner
cooldown metadata, and no endpoint writes user-editable fields.

Mutating requests must also send `Content-Type: application/json`.

## Response envelope

Success:

```json
{ "success": true, "data": { } }
```

Error (from `LiveTradeError.toBody()`):

```json
{ "error": "Human readable message.", "code": "MACHINE_CODE", "details": { } }
```

`details` is present only when the error carries structured information (for
example validation issues or the current version on a conflict).

## Status codes

| Status | Codes |
| --- | --- |
| 200 | Successful read, update, reorder or delete |
| 201 | Item or group created |
| 400 | `INVALID_BODY`, `INVALID_QUERY` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | `FORBIDDEN` (Origin rejected) |
| 404 | `NOT_FOUND` (valid but missing or foreign-owned identifier) |
| 409 | `DUPLICATE_ITEM`, `DUPLICATE_GROUP`, `ITEM_LIMIT`, `GROUP_LIMIT`, `EDIT_CONFLICT`, `REORDER_STALE`, `WRITE_BUSY` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `INVALID_GROUP`, `INSTRUMENT_NOT_SYNCED`, `INSTRUMENT_INACTIVE` |
| 429 | `QUOTE_COOLDOWN` (per-owner quote floor), `RATE_LIMITED` (provider throttling) |
| 502 | `QUOTE_FETCH_FAILED` (provider/network failure) |
| 500 | `INTERNAL` |

Request bodies are limited to 64 KiB. Invalid JSON, empty bodies and non-object
payloads are rejected before any database work. Error responses never contain
SQL, driver messages, stack traces, sessions or credentials.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/live-trade/board` | Complete owner workspace (quote-free) |
| GET | `/api/live-trade/quotes` | Batched market snapshot with zone distances |
| GET | `/api/live-trade/zones` | Batched nearest-zone summaries and expanded zones |
| GET | `/api/live-trade/instruments?q=` | Active NSE instrument search |
| POST | `/api/live-trade/items` | Add an item |
| PATCH | `/api/live-trade/items/{itemId}` | Update an item |
| DELETE | `/api/live-trade/items/{itemId}?version=` | Delete an item |
| PATCH | `/api/live-trade/items/reorder` | Reorder all items |
| GET | `/api/live-trade/groups` | List groups |
| POST | `/api/live-trade/groups` | Create a group |
| PATCH | `/api/live-trade/groups/{groupId}` | Rename a group |
| DELETE | `/api/live-trade/groups/{groupId}?version=` | Delete a group |
| PATCH | `/api/live-trade/groups/reorder` | Reorder all groups |

### GET /api/live-trade/board

Returns groups and items in saved order, instrument-master metadata and a
batched zone-summary section. It performs three workspace reads (groups, items,
instrument master) and, when the board has items, exactly two more bounded
batched reads (nearest zones and coverage). It never calls Kite or the scanner,
holds no in-memory quote state and is deliberately independent of `/quotes`, so
the board renders when market data is unavailable.

```json
{
  "success": true,
  "data": {
    "groups": [
      {
        "groupId": "8f0c…",
        "name": "Momentum",
        "sortOrder": 0,
        "version": 1,
        "createdAt": "2026-11-06T10:00:00.000Z",
        "updatedAt": "2026-11-06T10:00:00.000Z"
      }
    ],
    "items": [
      {
        "itemId": "c1a2…",
        "instrumentId": 408065,
        "symbol": "INFY",
        "companyName": "Infosys Limited",
        "groupId": "8f0c…",
        "priority": "HIGH",
        "direction": "BUY",
        "timeframe": "1D",
        "entryPrice": 1500.5,
        "targetPrice": 1600,
        "stopLoss": 1450,
        "notes": "Watching the retest.",
        "tradeStatus": "WATCHING",
        "sortOrder": 0,
        "version": 3,
        "createdAt": "2026-11-06T10:05:00.000Z",
        "updatedAt": "2026-11-06T10:10:00.000Z"
      }
    ],
    "instrumentMaster": {
      "latestInstrumentUpdateAt": "2026-11-05T18:00:00.000Z",
      "activeInstrumentCount": 2100,
      "freshness": "unknown",
      "stale": null
    },
    "zones": {
      "available": true,
      "status": "available",
      "freshnessThresholdDays": 7,
      "summaries": [
        {
          "instrumentId": 408065,
          "symbol": "INFY",
          "preferredTimeframe": "1D",
          "coverage": "AVAILABLE",
          "zoneFreshness": {
            "freshnessThresholdDays": 7,
            "latestCoveringScanAt": "2026-11-05T18:00:00.000Z",
            "latestZoneFormationAt": "2026-11-04T00:00:00.000Z",
            "latestZoneCreatedAt": "2026-11-04T00:00:00.000Z",
            "zoneCount": 4,
            "activeZoneCount": 3
          },
          "nearestDemand": {
            "zoneId": "d4c1…",
            "instrumentId": 408065,
            "symbol": "INFY",
            "side": "DEMAND",
            "timeframe": "1D",
            "pattern": "DBR",
            "zoneLow": 1480.5,
            "zoneHigh": 1502,
            "proximal": 1502,
            "distal": 1480.5,
            "formationScore": 64,
            "lifecycleState": "RETESTED",
            "formationTs": "2026-11-04T00:00:00.000Z",
            "createdAt": "2026-11-04T00:00:00.000Z",
            "touchCount": 2,
            "lastTouchTs": "2026-11-05T00:00:00.000Z",
            "timeframeMatch": "PREFERRED",
            "distancePercent": null,
            "distanceBasis": "PROXIMAL"
          },
          "nearestSupply": null
        }
      ]
    },
    "generatedAt": "2026-11-06T10:15:00.000Z"
  }
}
```

The board's zone summaries never contain a distance: the board performs no
quote lookup, so `distancePercent` is always `null` here. Distances are computed
only by `/quotes` from the quote it has already fetched. The board returns no
expanded zone lists.

Instrument-master freshness:

- `latestInstrumentUpdateAt` is `MAX(updated_at)` over Kite-sourced NSE
  instrument rows: the newest individual row update. It is **not** a completed
  sync timestamp.
- `freshness` is always `unknown` and `stale` is always `null`. The schema has
  no sync-metadata table, and `bulkUpsert` writes the master in chunks that
  commit as separate statements without a wrapping transaction. An interrupted
  or failed sync can therefore leave recent timestamps on only part of the
  master, so no reliable "last completed sync" time exists to compare against.
- Clients may display `latestInstrumentUpdateAt` as informational only. Treating
  `unknown` as "current", or deriving a stale warning from this field, would
  overstate what the data proves.
- `activeInstrumentCount` is the number of active NSE rows and is independent of
  the timestamp.

### GET /api/live-trade/instruments?q=INFY

Case-insensitive partial search over **active NSE** instruments by symbol or
company name. `q` is trimmed; it is required, must contain at least one
non-whitespace character and is limited to 50 characters. Results are capped at
20 and ordered exact match, prefix match, substring match, name-only match,
then symbol. The endpoint never triggers a sync.

```json
{
  "success": true,
  "data": {
    "query": "INFY",
    "instruments": [
      {
        "instrumentId": 408065,
        "symbol": "INFY",
        "tradingSymbol": "INFY",
        "name": "Infosys Limited",
        "exchange": "NSE",
        "active": true,
        "updatedAt": "2026-11-05T18:00:00.000Z"
      }
    ],
    "instrumentMaster": {
      "latestInstrumentUpdateAt": "2026-11-05T18:00:00.000Z",
      "activeInstrumentCount": 2100,
      "freshness": "unknown",
      "stale": null
    }
  }
}
```

`instruments.symbol` stores the Kite trading symbol, so `tradingSymbol` is the
same value. Inactive and non-NSE rows are excluded. An empty master returns an
empty list with `freshness: "unknown"`, not an error. No automatic sync is
attempted. Freshness semantics are identical to the board response.

### GET /api/live-trade/quotes[?instrumentIds=1,2]

Batched market snapshot for the authenticated owner's selected instruments. The
owner comes from the server-side session; owner query parameters and headers are
ignored.

- `instrumentIds` is an optional comma-separated list of **positive integers**.
  Absent means every instrument on the owner's board. Blank, duplicate,
  non-numeric, non-positive or more than 200 ids are `400 INVALID_QUERY`.
  A valid id that is not on the owner's board is `404 NOT_FOUND`, identical to a
  missing instrument; the response never reveals another owner's data.
- An empty selection returns `200` with `quotes: []` and performs **no**
  cooldown claim and **no** Kite request.
- One bounded Kite batch call is made for at most 200 symbols (the board item
  limit; Kite accepts up to 500). There is no per-instrument request.
- The endpoint never returns the access token, session fields or raw provider
  payloads.

```json
{
  "success": true,
  "data": {
    "quotes": [
      {
        "instrumentId": 408065,
        "symbol": "INFY",
        "lastPrice": 1505.25,
        "change": 12.5,
        "changePercent": 0.8375,
        "lastTradedAt": "2026-11-06T09:28:41.000Z",
        "fetchedAt": "2026-11-06T09:29:00.000Z",
        "freshness": "LIVE",
        "errorCode": null,
        "nearestDemand": {
          "zoneId": "d4c1…",
          "instrumentId": 408065,
          "symbol": "INFY",
          "side": "DEMAND",
          "timeframe": "1D",
          "pattern": "DBR",
          "zoneLow": 1480.5,
          "zoneHigh": 1502,
          "proximal": 1502,
          "distal": 1480.5,
          "formationScore": 64,
          "lifecycleState": "RETESTED",
          "formationTs": "2026-11-04T00:00:00.000Z",
          "createdAt": "2026-11-04T00:00:00.000Z",
          "touchCount": 2,
          "lastTouchTs": "2026-11-05T00:00:00.000Z",
          "timeframeMatch": "PREFERRED",
          "distancePercent": 0.2170,
          "distanceBasis": "PROXIMAL"
        },
        "nearestSupply": null
      }
    ],
    "market": {
      "isOpen": true,
      "exchange": "NSE",
      "approximation": "NSE regular session Monday-Friday 09:15-15:30 IST; exchange holidays and special sessions are not modelled."
    },
    "cooldownSeconds": 5,
    "requestedInstruments": 1,
    "zonesAvailable": true,
    "fetchedAt": "2026-11-06T09:29:00.000Z"
  }
}
```

Quote fields:

| Field | Meaning |
| --- | --- |
| `lastPrice` | Provider last traded price. `null` when no valid quote exists; never `0` as a stand-in. |
| `change`, `changePercent` | `lastPrice - previousClose` and percentage. Both `null` when the provider's `ohlc.close` is missing or not a positive finite number. |
| `lastTradedAt` | Provider trade time as a correct UTC instant; `null` when missing, invalid or materially in the future. |
| `fetchedAt` | Server time when the provider response was received — the same instant used for market-session state and freshness. |
| `freshness` | See below. |
| `errorCode` | One of `QUOTE_NOT_RETURNED`, `QUOTE_INVALID`, `QUOTE_TIMESTAMP_INVALID`, or `null`. |
| `nearestDemand`, `nearestSupply` | Price-eligible nearest zone for the **validated quote** (see below). `null` when no zone qualifies, the quote is unavailable, or `zonesAvailable` is false. |
| `zonesAvailable` (response) | `false` only when the batched nearest-zone read failed. Quote values remain valid and every nearest zone is `null`. A provider failure is still an API error and is never reported this way. |

Kite timestamp handling:

- Kite sends quote times as IST wall-clock strings (`YYYY-MM-DD HH:MM:SS`). The
  adapter converts them to the correct UTC instant as Asia/Kolkata, independent
  of the server's own timezone. The Kite SDK's conversion of the same 19-char
  value to a `Date` is also recovered from its wall-clock components.
- ISO strings with `Z` or an explicit offset are honoured as the instant they
  declare. Invalid or impossible values become
  `UNAVAILABLE`/`QUOTE_TIMESTAMP_INVALID`.
- A timestamp up to 60 seconds ahead of the server is tolerated as clock skew.
  A timestamp further in the future cannot describe a real trade and is treated
  as invalid, never `LIVE`.

Nearest-zone semantics differ by endpoint:

- The board and `/zones` have no quote, so they use **structural** selection:
  highest proximal for `DEMAND`, lowest proximal for `SUPPLY`.
- `/quotes` uses the **validated quote price** in the same single batched query.
  A zone is eligible only when it is on the correct side of the price:
  `DEMAND: distal <= currentPrice`, `SUPPLY: distal >= currentPrice`. A zone that
  contains the current price is therefore eligible. Price eligibility is applied
  before preferred-timeframe ranking, so a preferred timeframe with no eligible
  zone falls back to another eligible timeframe.
- An unavailable quote supplies no price and keeps the structural selection,
  with `distancePercent: null`.

Freshness states:

- `LIVE` — valid quote during the approximate session whose provider timestamp
  is at most 300 seconds old (`LIVE_TRADE_QUOTE_LIVE_MAX_AGE_SECONDS`).
- `DELAYED` — valid quote during the approximate session older than 300 seconds.
- `LAST_CLOSE` — valid quote while the market is closed (latest valid snapshot).
- `UNAVAILABLE` — no valid quote; `lastPrice`/`change`/`lastTradedAt` are null
  and `errorCode` explains why.
- `SIGN_IN_REQUIRED` — produced **by the client** when it retains a snapshot
  after the API returned `401`. The server never returns this label.
- `STALE` — produced **by the client** when a refresh fails and it retains the
  previous snapshot with its original timestamp. The server keeps no quote
  cache, so it can never relabel old data as current.

The session approximation is Monday–Friday 09:15–15:30 IST, computed from the
server clock. Exchange holidays, special sessions and outages are **not**
modelled; `market.approximation` states this in every response.

Cooldown:

- At most one quote request per owner per **5 seconds**, shared by all server
  instances through one atomic `INSERT … ON CONFLICT … WHERE … RETURNING`
  against `live_trade_quote_state`. No in-memory state is used.
- The claim is a short autocommit statement committed **before** Kite is called;
  no transaction or row lock is held during the provider request.
- A rejected request returns `429 QUOTE_COOLDOWN` with
  `details.retryAfterSeconds`, a matching `Retry-After` header and the standard
  JSON error envelope, and never calls Kite. Owners are independent.
- A failed Kite call still consumes the cooldown, because the claim has already
  committed. This is intentional: failures must not become a request amplifier.
- `cooldownSeconds` (5) is the server floor; a client polling every 30 seconds
  is well above it.

Error mapping:

| Condition | Response |
| --- | --- |
| Missing/blank/expired session token | `401 TOKEN_EXPIRED` |
| Provider reports an invalid/expired token | `401 TOKEN_EXPIRED` |
| Provider reports missing market-data permission | `403 FORBIDDEN` (safe message) |
| Provider rate limiting | `429 RATE_LIMITED` |
| Network or unknown provider failure | `502 QUOTE_FETCH_FAILED` |
| Requested id not on the owner's board | `404 NOT_FOUND` |
| Nearest-zone read failed (quotes intact) | `200` with `zonesAvailable: false` and null nearest zones |

Provider classification prefers Kite's structured `error_type` and any numeric
HTTP status (`TokenException`, `PermissionException`, `RateLimitException`, 401,
403, 429). Message matching is only a fallback when no structured type is
present; a bare number inside an unrelated message is not treated as
authoritative. Provider messages are never forwarded; only the error name,
error type, status and numeric code are logged.

### GET /api/live-trade/zones

Batched demand/supply zone summaries for the owner's selected instruments, plus
an optional expanded, paginated list for exactly one instrument. No quote is
fetched and no scanner job is started.

Query parameters:

| Parameter | Rules |
| --- | --- |
| `instrumentIds` | Optional comma-separated positive integers, max 200, no duplicates, restricted to the owner's board. |
| `timeframe` | Optional scanner timeframe (`1H`, `4H`, `1D`, `1W`, `1M`, `3M`, `6M`, `1Y`) or `any`. Absent uses each item's saved timeframe. |
| `includeExpanded` | `true`/`false` only. `true` requires exactly one selected instrument. |
| `limit` | 1–500, default 100. |
| `offset` | 0–4999, default 0; `offset + limit ≤ 5000`. |

The response:

```json
{
  "success": true,
  "data": {
    "summaries": [ /* one entry per selected instrument, same shape as the board */ ],
    "expanded": {
      "instrumentId": 408065,
      "symbol": "INFY",
      "zones": [
        {
          "zoneId": "d4c1…",
          "instrumentId": 408065,
          "symbol": "INFY",
          "timeframe": "1D",
          "pattern": "DBR",
          "side": "DEMAND",
          "zoneLow": 1480.5,
          "zoneHigh": 1502,
          "proximal": 1502,
          "distal": 1480.5,
          "baseStart": "2026-11-01T00:00:00.000Z",
          "baseEnd": "2026-11-03T00:00:00.000Z",
          "legInTs": "2026-10-31T00:00:00.000Z",
          "legOutTs": "2026-11-04T00:00:00.000Z",
          "formationTs": "2026-11-04T00:00:00.000Z",
          "formationScore": 64,
          "lifecycleState": "RETESTED",
          "lastTouchTs": "2026-11-05T00:00:00.000Z",
          "touchCount": 2,
          "configVersion": 1,
          "createdAt": "2026-11-04T00:00:00.000Z",
          "distancePercent": null,
          "distanceBasis": "PROXIMAL"
        }
      ],
      "pagination": {
        "limit": 100,
        "offset": 0,
        "page": 1,
        "returned": 1,
        "hasMore": false,
        "batchLimit": 5000
      }
    },
    "timeframeContext": { "hasOverride": false, "value": null },
    "freshnessThresholdDays": 7,
    "generatedAt": "2026-11-06T10:15:00.000Z"
  }
}
```

`expanded` is `null` unless `includeExpanded=true`.

Nearest-zone selection (**structural** for this endpoint):

- Per selected instrument and side, the repository selects exactly one eligible
  zone with a single batched `LEFT JOIN LATERAL … LIMIT 1` statement — not one
  request or query per instrument, and not an in-memory load of all zones.
- This endpoint has no quote, so eligibility uses no current price: the
  instrument is on the owner's board, the side matches, the zone is not
  `BROKEN`, and `proximal` is a finite positive number (`NaN`/`Infinity` are
  rejected in SQL).
- Ordering: preferred timeframe first (the request override when supplied, else
  the item's saved timeframe), then structural nearest — **highest proximal for
  DEMAND**, **lowest proximal for SUPPLY** — then newest `formation_ts`, then
  `zone_id` for a deterministic tie-break.
- If no zone matches the preferred timeframe, the next eligible timeframe is
  used and `timeframeMatch` is `FALLBACK`. `ANY` means the item/request has no
  timeframe preference. A null preferred timeframe means all timeframes.
- `/quotes` reuses this batched query but passes the validated quote price and
  applies the price-side rules described there. Price eligibility is part of
  the `WHERE` clause, so it precedes timeframe ranking and fallback.
- `formationScore` is the existing `zones.score` column. `composite_score` is
  legacy and unused. Zones are never filtered by score; a score below 50 is
  still selectable and still listed.
- `BROKEN` zones are never nearest demand/supply, never participate in any
  distance, and never null out the side — they simply are not candidates. They
  remain visible in the expanded list with `lifecycleState: "BROKEN"` and
  `distancePercent: null`.
- `distancePercent` is only produced by `/quotes` from a verified quote:
  `((currentPrice - proximal) / proximal) * 100`, signed and unrounded. It is
  `null` whenever the quote or proximal is missing/non-finite/non-positive.
  `distanceBasis` states the boundary used (`PROXIMAL`). This is a geometric
  distance, **not** a probability, expected return or recommendation.

Coverage states (`summaries[].coverage`):

| State | Meaning |
| --- | --- |
| `AVAILABLE` | A successful scan covering the instrument completed within the freshness window **and** zone rows currently exist. |
| `NO_ZONES` | A fresh covering scan completed and no zone rows currently exist for the instrument. |
| `OUTSIDE_SCANNER_UNIVERSE` | The instrument is not an active current Nifty 500 member. Existing zones (for example from a single-symbol scan) are still returned. |
| `NO_SCAN_HISTORY` | Successful scans exist, none covers this instrument, and every scan's instrument set is attributable. |
| `STALE` | The latest covering scan is older than the freshness window (7 days). |
| `UNKNOWN` | The evidence cannot distinguish the cases above (no completed scan, a success with no `completed_at`, or an unattributable legacy scan). The API does not guess between `NO_ZONES` and `NO_SCAN_HISTORY`. |

Coverage evidence comes from successful `scan_jobs` whose `instrument_ids`
contain the instrument, or from successful `DETECT_ZONES` batches in successful
jobs. The batch fallback exists for legacy or externally populated history: the
current scanner's batch writer records an empty `instrument_ids` array for every
batch, so live scans are attributed through the job-level list. A job with a
null `completed_at` is not evidence.

`AVAILABLE` is a conservative composite, not provenance proof: it does not
claim that the existing zone rows were written by the covering scan. Zone rows
and scan coverage are independent evidence, and `latestZoneFormationAt` is
returned separately for display and may predate the covering scan.
`zones.created_at` is **not** used as a freshness signal: zones are idempotent
and are not rewritten when re-detected.

Expanded-list rules:

- Offset pagination is best-effort and not snapshot-consistent; concurrent
  scans can shift rows between pages. The response always reports `page`,
  `offset`, `returned` and `hasMore`. The client must not claim it has loaded
  all zones if paging stops early.
- No page exceeds 500 zones; one client interaction may page through at most
  5,000 zones (`batchLimit`).
- Ordering is deterministic: `formation_ts DESC`, `score DESC`, `zone_id ASC`.
  Duplicate `zoneId` values in a page are removed application-side before the
  response.
- `BROKEN` zones and scores below 50 are retained.
- Expanded zones never carry a distance, because the endpoint fetches no quote.

### POST /api/live-trade/items

Creates an item. Server-controlled values are rejected: owner, `itemId`,
`sortOrder`, `version`.

```json
{
  "instrumentId": 408065,
  "groupId": null,
  "priority": "HIGH",
  "direction": "BUY",
  "timeframe": "1D",
  "entryPrice": 1500.5,
  "targetPrice": 1600,
  "stopLoss": 1450,
  "notes": "Watching the retest.",
  "tradeStatus": "WATCHING"
}
```

- `instrumentId` is required and must be an active NSE instrument.
- Omitted `timeframe` means `"1D"`; explicit `null` means Any.
- Omitted `priority`, `tradeStatus`, `direction`, prices, `notes` and `groupId`
  default to `MEDIUM`, `WATCHING`, `null`, `null`, `""` and `null`.
- One item per owner per instrument (`DUPLICATE_ITEM`).
- Item limit: 200 (`ITEM_LIMIT`).
- Unknown/non-NSE instrument: `422 INSTRUMENT_NOT_SYNCED`.
- Inactive instrument: `422 INSTRUMENT_INACTIVE`.
- Unknown/foreign group: `422 INVALID_GROUP`.

Returns `201` with the created item in `data`.

### PATCH /api/live-trade/items/{itemId}

Partial update. `version` is required. Editable fields: `groupId`, `priority`,
`direction`, `timeframe`, `entryPrice`, `targetPrice`, `stopLoss`, `notes`,
`tradeStatus`.

- Omitted `timeframe` is unchanged; explicit `null` means Any.
- `instrumentId` is immutable.
- A malformed `itemId` returns `400 INVALID_QUERY` before the body is parsed.
- A valid but missing or foreign-owned `itemId` returns `404 NOT_FOUND`; the
  response never reveals whether another owner holds the record.
- A stale `version` returns `409 EDIT_CONFLICT` with
  `details.currentVersion`.
- Assigning an unknown/foreign group returns `422 INVALID_GROUP`.

```json
{ "version": 3, "priority": "HIGH", "timeframe": null }
```

Returns `200` with the updated item.

### DELETE /api/live-trade/items/{itemId}?version=3

Deletes the item only when `version` matches. A malformed `itemId` is
`400 INVALID_QUERY`; a missing or malformed version is also `400 INVALID_QUERY`;
a stale version is `409 EDIT_CONFLICT`; a valid but missing or foreign-owned item
is `404 NOT_FOUND`.

Returns `200`:

```json
{ "success": true, "data": { "deleted": true } }
```

### PATCH /api/live-trade/items/reorder

Requires the complete set of the owner's item IDs, once each, in the new order.

```json
{ "orderedItemIds": ["c1a2…", "d3b4…"] }
```

- Duplicate or malformed IDs: `400 INVALID_BODY`.
- A set that differs from the owner's current items (concurrent create/delete
  or a foreign ID): `409 REORDER_STALE`.
- An empty array succeeds only when the owner has zero items.
- Each updated item's `version` increments.

Returns `200` with `data.items` in the new order.

### Groups

`GET /api/live-trade/groups` returns `data.groups` in saved order.

`POST /api/live-trade/groups` accepts `{ "name": "Momentum" }`. Names are
trimmed, 1–60 characters, reject control characters and are unique per owner
case-insensitively. Limits: 20 groups. Errors: `400 INVALID_BODY`,
`409 DUPLICATE_GROUP`, `409 GROUP_LIMIT`. Returns `201` with the group.

`PATCH /api/live-trade/groups/{groupId}` accepts `{ "name": "New", "version": 1 }`.
A malformed `groupId` is `400 INVALID_QUERY` before the body is parsed; a valid
but missing or foreign-owned group is `404 NOT_FOUND`; a stale version is
`409 EDIT_CONFLICT`; a duplicate name is `409 DUPLICATE_GROUP`.

`DELETE /api/live-trade/groups/{groupId}?version=1` atomically ungroups the
group's items and deletes the group. Ungrouped items keep their owner, receive
`groupId: null`, and their `version` increments. A malformed `groupId` or a
missing/malformed version is `400 INVALID_QUERY`; a valid but missing or
foreign-owned group is `404 NOT_FOUND`; stale is `409 EDIT_CONFLICT`.

Returns `200` with `{ "deleted": true }`.

`PATCH /api/live-trade/groups/reorder` accepts
`{ "orderedGroupIds": ["…", "…"] }` and follows the same exact-set and stale
rules as item reorder. Returns `200` with `data.groups` in the new order.

## Concurrency

Every update and delete carries an expected `version`. Successful updates and
reorders increment it. Clients must send the version they received and reload
on `409 EDIT_CONFLICT` or `409 REORDER_STALE`.

## Client-editable vs server-controlled

| Field | Create | Update | Source |
| --- | --- | --- | --- |
| `instrumentId` | editable (required) | immutable | client |
| `groupId` | editable | editable | client |
| `priority`, `direction`, `timeframe`, `tradeStatus` | editable | editable | client |
| `entryPrice`, `targetPrice`, `stopLoss`, `notes` | editable | editable | client |
| `itemId`, `groupId` (identity), `owner_user_id` | server | server | server |
| `sortOrder`, `version`, `createdAt`, `updatedAt` | server | server | server |
| Group `name` | editable | editable | client |
| Group `owner_user_id`, `sortOrder`, `version`, timestamps | server | server | server |

## Rate and load characteristics

- A board load is 3 workspace reads plus, when the board has items, 2 batched
  zone reads. There is no per-item query. The response is quote-free.
- A zone overview is 1 selection read plus 2 batched reads, and optionally 1
  expanded-page read. No quote and no scanner work.
- A quote request is 1 selection read, 1 atomic cooldown claim, 1 Kite batch
  call and 1 batched nearest-zone read. It is bounded by the 200-item board
  limit and the 500-symbol Kite limit.
- The quote request order is fixed: selection → cooldown claim → Kite batch →
  validated quotes → one batched nearest-zone read. The only prices passed to
  the nearest query are validated finite positive provider prices; an
  unavailable or invalid quote contributes no price and therefore selects
  structurally.
- Quote validity and zone enrichment are independent. If Kite succeeds but the
  nearest-zone read fails, the request still returns `200` with the real quote
  values, `nearestDemand`/`nearestSupply` null and `zonesAvailable: false`. The
  failure is logged with the error name only and never leaks SQL or provider
  text. A Kite failure keeps the existing error mapping and never degrades.
- No endpoint loads the full instrument universe, reads all zones into memory,
  recalculates zones, issues one request/query per instrument or starts a scan.

## Phase boundaries

Not implemented in Phase 5: Live Trade UI or periodic refresh, Kite WebSocket
streaming, scanner job execution, P&L, order placement/broker integration and
AI recommendations. Quotes are request/response snapshots only; the server
keeps no price history or quote cache.

## Production-readiness blockers

1. **Migration not applied.** `db/migrations/2026-11-06-add-live-trade.sql`
   must be applied before these endpoints work against a real database. It was
   not applied during Phase 5. The quote cooldown additionally requires the
   `live_trade_quote_state` table defined there; without it, `/quotes` fails
   closed with `500 INTERNAL`.
2. **Database timeout policy is unchanged.** `lib/db.ts` still creates the Neon
   client without an explicit bounded timeout. The agreed bounded timeout
   policy must be implemented and verified before production deployment; this
   phase does not silently change it.
3. **No instrument-name index.** The `instruments` schema has no index on
   `symbol` or `company_name`, so search is a bounded sequential scan over
   active NSE rows with `LIMIT 20`. Adding an index is a schema decision outside
   Phase 5.
4. **Instrument freshness cannot be determined.** There is no dedicated
   sync-metadata table, and the master is upserted in independently committed
   chunks, so no timestamp proves a full sync completed. The API exposes
   `latestInstrumentUpdateAt` for information and reports `freshness: "unknown"`.
   A real freshness signal requires sync metadata or a sync workflow change.
5. **Session approximation has no holiday calendar.** Market open/closed is a
   weekday 09:15–15:30 IST approximation. Exchange holidays, special sessions
   and early closes are not modelled; a quote on such a day may be labelled
   `LIVE`/`DELAYED` instead of `LAST_CLOSE`. The limitation is returned in
   `market.approximation`.
6. **No server-side quote history.** The server cannot preserve or replay a
   prior quote. `SIGN_IN_REQUIRED` and `STALE` are client-side labels for a
   retained snapshot after a `401` or a failed refresh; the retained snapshot
   keeps its original timestamp.
7. **Coverage evidence relies on JSONB containment.** `scan_jobs.instrument_ids`
   and `scan_job_batches.instrument_ids` are JSONB arrays. The containment
   predicates are supported by existing `scan_jobs(status, lease_expires_at)`
   and `scan_job_batches(job_id, stage, status)` indexes only indirectly; large
   scan histories should be measured on real Neon before relying on latency
   targets.
8. **Offset pagination is not snapshot-consistent.** Concurrent scans can shift
   rows between pages. The response exposes `page`, `offset`, `returned` and
   `hasMore`; clients must treat an interrupted load as partial.

### Real PostgreSQL verification still required

All Phase 5 and 5.2 correctness tests run against a stateful fake database. The
fake mirrors the SQL contract, but it is not PostgreSQL, so the following must
be measured against real Neon after the migration is applied and before
production traffic. None of these were executed in this phase, and no index or
benchmark was added.

- **Cooldown under concurrency.** Two independent connections racing the same
  owner must yield exactly one successful claim and one `429`, proving the
  `INSERT … ON CONFLICT (owner_user_id) DO UPDATE … WHERE … RETURNING` guard
  rather than sequential calls in one process.
- **JSONB containment.** `scan_jobs.instrument_ids` and
  `scan_job_batches.instrument_ids` containment should be checked for plan
  shape and latency as scan history grows.
- **Nearest-zone query at the maximum selection.** Verify the lateral nearest
  read at 200 instruments with and without `unnest` prices, including real
  `NUMERIC` NaN/Infinity handling.
- **Expanded pagination.** Verify deep `offset` reads (up to 4,999) stay within
  latency targets and are stable across concurrent scans.
- **Bounded statement and lock timeouts.** Apply and verify the agreed bounded
  Neon timeout policy (blocker 2) so a slow provider-adjacent query cannot hold
  a connection indefinitely.

## Proposed index (not applied)

If real Neon measurements show the zone reads are slow, a candidate is
`CREATE INDEX … ON zones (instrument_id, side, lifecycle_state, proximal)`.
It is not applied here: schema changes require explicit approval and a separate
migration.
