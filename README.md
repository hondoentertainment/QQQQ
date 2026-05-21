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
- **Sector allocation** breakdown of the whole fund.
- **Near real-time** — the view auto-refreshes every 60s; data is refreshed by
  a scheduled job (see below).
- **Zero dependencies** — plain HTML/CSS/JS frontend, a Node built-in static
  server, and a fetch script using only the Node standard library.

## Project layout

```
index.html / styles.css / app.js   The dashboard interface
server.js                          Zero-dep static server (+ /api/refresh)
scripts/fetch-holdings.js          Fetches Invesco holdings + Yahoo prices
data/holdings.json                 Current holdings snapshot
data/monthly-allocations.json      Per-ticker monthly allocation history
.github/workflows/refresh.yml      The recurring cron job
```

## Run it locally

Requires Node.js 20+ (no `npm install` needed — there are no dependencies).

```bash
npm start                 # serve the dashboard at http://localhost:3000
npm run refresh           # refresh data/*.json once, right now
REFRESH_MINUTES=30 npm start   # serve + auto-refresh data every 30 min
```

## The recurring cron job

Data is refreshed by **`.github/workflows/refresh.yml`**, a scheduled GitHub
Actions workflow. It runs `scripts/fetch-holdings.js`, which:

1. Downloads the official QQQ holdings file from Invesco (ticker, name,
   sector, index weight).
2. Fetches a live quote for each component from Yahoo Finance.
3. Writes `data/holdings.json` and appends the current month's weights to
   `data/monthly-allocations.json` (building up history over time).
4. Commits the updated data back to the repo.

Schedule: every 30 minutes during US market hours, plus a post-close snapshot.
Trigger it manually any time from the **Actions** tab ("Run workflow").

If a data source is temporarily unreachable, the script falls back to the
last good data so the job stays green and the site keeps working.

> Self-hosting instead of GitHub Actions? `REFRESH_MINUTES=30 npm start` runs
> the same refresh on an interval inside the server, and the dashboard's
> **Refresh now** button calls `POST /api/refresh` on demand.

## Deploy as a site

The dashboard is fully static. Enable **GitHub Pages** for this repo
(Settings → Pages → "Deploy from a branch", root folder). The cron job's
commits to `data/*.json` trigger a fresh deploy automatically.

## Data sources & notes

- Holdings/weights: Invesco QQQ official holdings file.
- Prices: Yahoo Finance chart API.
- The committed `data/*.json` ships with a **sample dataset** (`source: "seed"`)
  so the dashboard works immediately; the first successful cron run replaces it
  with live data.

For informational purposes only — not investment advice.
