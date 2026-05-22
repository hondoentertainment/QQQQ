# Data contract — QQQQ Component Tracker

This document describes the committed JSON files and the optional live quotes API.
All documents share `schemaVersion: 1` until a breaking v2 release.

## `data/holdings.json`

Current fund snapshot: weights, sectors, and last-known prices.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schemaVersion` | number | yes | Must be `1` |
| `fund` | string | yes | Always `"QQQ"` |
| `name` | string | yes | Display name |
| `legacyTicker` | string | no | `"QQQQ"` |
| `asOf` | string (ISO) | yes | Snapshot timestamp |
| `source` | string | yes | `invesco`, `fmp`, `sec-nport`, `*-cached`, or `seed` |
| `count` | number | yes | Number of holdings |
| `totalWeight` | number | yes | Sum of weights (~100) |
| `holdings` | array | yes | Sorted by weight descending |

Each holding:

| Field | Type | Required |
|-------|------|----------|
| `ticker` | string | yes |
| `name` | string | yes |
| `sector` | string | yes |
| `weight` | number | yes |
| `price` | number \| null | no |
| `changePct` | number \| null | no |
| `marketCap`, `pe`, `yearHigh`, `yearLow` | number \| null | no |

## `data/monthly-allocations.json`

Month-by-month weight history per ticker.

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | number | yes |
| `fund` | string | yes |
| `months` | string[] | yes | `YYYY-MM`, oldest first |
| `allocations` | object | yes | `{ [ticker]: { [month]: weight } }` |

## `data/changes.json`

Index constituent add/remove events.

| Field | Type | Required |
|-------|------|----------|
| `events` | array | yes |

Each event: `{ date, added: [{ ticker, name }], removed: [{ ticker, name }] }`.

## `data/price-history.json`

Daily fund-level close prices (optional for the dashboard).

Array of `{ date: "YYYY-MM-DD", close: number }`, sorted oldest first.

## `data/refresh-status.json`

Last pipeline run summary for the footer health line.

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | number | yes |
| `runAt` | string (ISO) | yes |
| `holdingsSource` | string | yes |
| `quoteSource` | string | yes |
| `holdingsCount` | number | yes |
| `pricedCount` | number | yes |
| `quoteSuccessRate` | number | yes | 0–1 |
| `fallback` | boolean | yes |
| `attempts` | array | no | `{ source, ok, error?, count? }[]` |

## `GET /api/quotes` (self-hosted only)

Available when running `node server.js` or on Vercel with the serverless handler.

Response:

```json
{
  "asOf": "2026-05-22T20:00:00.000Z",
  "source": "yahoo",
  "count": 98,
  "quotes": {
    "AAPL": {
      "price": 308.82,
      "changePct": 2.17,
      "marketCap": 0,
      "pe": 0,
      "yearHigh": 311.4,
      "yearLow": 193.46
    }
  }
}
```

On static hosting (GitHub Pages) this endpoint is absent; the dashboard uses
committed prices from `holdings.json`.

## Validation

`scripts/fetch-holdings.js` validates documents with `validateHoldingsDocument`,
`validateMonthlyDocument`, and `validateRefreshStatus` from `lib/holdings.js`
before writing files.

## Breaking changes (v2)

A v2 bump requires updating `SCHEMA_VERSION` in `lib/holdings.js`, this document,
and any consumers. Non-breaking additions may land in v1.x with optional fields.
