# QQQQ Component Tracker

A web dashboard for every component of **QQQQ** with current weights, live
prices, and a month-by-month allocation history — plus a recurring cron job
that keeps the data fresh.

> **What is "QQQQ"?** `QQQQ` is the legacy ticker for the **Invesco QQQ Trust**
> (renamed to `QQQ` in 2011), the ETF that tracks the **Nasdaq-100 Index**. Its
> "components" are the ~100 Nasdaq-100 constituents — that's what this tracker
> shows.

## Features

- **All components in one table** — ticker, company, sector, index weight,
  live price, and day move, sortable and filterable.
- **Monthly allocation history** — every holding has a 6-month allocation
  sparkline; click a row for a full bar chart and month-by-month deltas.
- **Index change tracking** — additions/removals between refreshes are
  recorded and surfaced in a banner.
- **Sector allocation** breakdown of the whole fund.
- **Near real-time** — the view auto-refreshes; when self-hosted it also polls
  live prices every 20s via the server.
- **Zero dependencies** — plain HTML/CSS/JS frontend, a Node built-in static
  server, and fetch scripts using only the Node standard library.

## Project layout

```
index.html / styles.css / app.js   The dashboard interface
server.js                          Zero-dep static server (+ /api/refresh, /api/quotes)
lib/quotes.js                      Shared live-quote fetching (FMP or Yahoo)
scripts/fetch-holdings.js          Fetches holdings + prices, writes data/*.json
data/holdings.json                 Current holdings snapshot
data/monthly-allocations.json      Per-ticker monthly allocation history
data/changes.json                 Log of constituent additions/removals
.github/workflows/refresh.yml      The recurring data-refresh cron job
.github/workflows/pages.yml        Deploys the dashboard to GitHub Pages
```

## Run it locally

Requires Node.js 20+ (no `npm install` needed — there are no dependencies).

```bash
npm start                      # serve the dashboard at http://localhost:3000
npm run refresh                # refresh data/*.json once, right now
REFRESH_MINUTES=30 npm start   # serve + auto-refresh data every 30 min
```

## The recurring cron job

Data is refreshed by **`.github/workflows/refresh.yml`**, a scheduled GitHub
Actions workflow. It runs `scripts/fetch-holdings.js`, which:

1. Fetches QQQ holdings (ticker, name, sector, index weight) — from Invesco,
   falling back to Financial Modeling Prep, then to the last good data.
2. Fetches a live quote for each component (FMP if a key is set, else Yahoo).
3. Writes `data/holdings.json`, appends the current month's weights to
   `data/monthly-allocations.json`, and logs any constituent changes to
   `data/changes.json`.
4. Commits the updated data back to the repo.

Schedule: every 30 minutes during US market hours, plus a post-close snapshot.
Trigger it manually any time from the **Actions** tab ("Run workflow").

If a data source is temporarily unreachable, the script falls back to the
last good data so the job stays green and the site keeps working.

### Recommended: add an `FMP_API_KEY` secret

Invesco's download endpoint and Yahoo Finance both block automated requests,
so the free path can be unreliable. For dependable data, get a free API key
from [Financial Modeling Prep](https://site.financialmodelingprep.com/) and
add it to the repo:

**Settings → Secrets and variables → Actions → New repository secret**
— name `FMP_API_KEY`, value = your key.

`refresh.yml` already passes it through; locally, run
`FMP_API_KEY=yourkey npm run refresh`.

## Near real-time prices

- The dashboard view re-reads the committed data every 60s.
- When self-hosted (`npm start`), the page also calls `GET /api/quotes` every
  20s; the server fetches fresh quotes (15s cache) so prices update between
  cron runs. On static hosting this call simply no-ops.
- True tick-level streaming would require a paid market-data feed and is out
  of scope; cron + server polling gives near-real-time without one.

## Deploy as a site

The dashboard is fully static. **`.github/workflows/pages.yml`** publishes it
to GitHub Pages on every push to `main` (including the cron's data commits).

One-time setup: **Settings → Pages → Source = "GitHub Actions"**.

## Data sources & notes

- Holdings/weights: Invesco QQQ official holdings file, or Financial Modeling
  Prep when `FMP_API_KEY` is set.
- Prices: Financial Modeling Prep (with key) or Yahoo Finance.
- The committed `data/*.json` ships with a **sample dataset** (`source: "seed"`)
  so the dashboard works immediately; the first successful cron run replaces it
  with live data.

For informational purposes only — not investment advice.
