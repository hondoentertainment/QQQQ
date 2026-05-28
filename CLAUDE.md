# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this project is

A web dashboard for the components of **QQQQ** — the legacy ticker for the
Invesco QQQ Trust, which tracks the Nasdaq-100. It shows ~100 constituents with
current weights, live prices, and month-by-month allocation history, kept fresh
by a scheduled GitHub Actions data-refresh job.

For the user-facing overview see `README.md`; for project direction see
`ROADMAP.md`. This file covers how the code is organized and how to work in it.

## Architecture in one paragraph

The dashboard is **plain static HTML/CSS/JS** (`index.html`, `styles.css`,
`app.js`) that reads three committed JSON files in `data/`. A scheduled cron
(`.github/workflows/refresh.yml`) runs `scripts/fetch-holdings.js`, which fetches
live holdings + prices, validates them, and commits updated `data/*.json` back
to the repo. `server.js` is an optional zero-dependency static server for local
use; `api/quotes.js` is the Vercel serverless equivalent of its `/api/quotes`
route. Pure, testable data-pipeline logic lives in `lib/`.

```
index.html / styles.css / app.js   Static dashboard (app.js runs in the browser)
server.js                          Zero-dep static server (+ /api/quotes, /api/refresh)
api/quotes.js                      Vercel serverless function backing /api/quotes
lib/holdings.js                    Pure data-pipeline helpers (parse/validate/diff)
lib/quotes.js                      Shared live-quote fetching (FMP or Yahoo)
scripts/fetch-holdings.js          Cron entrypoint: fetch -> validate -> write data/*.json
data/holdings.json                 Current holdings snapshot
data/monthly-allocations.json      Per-ticker monthly allocation history (24-month cap)
data/changes.json                  Log of constituent additions/removals (50-event cap)
test/*.test.js                     Unit/integration tests (node:test)
e2e/smoke.test.js                  Playwright browser smoke test
.github/workflows/                 ci.yml (lint+test), refresh.yml (cron), pages.yml (deploy)
```

## Non-negotiable constraints

These shape every change. Breaking one needs an explicit, recorded decision
(see `ROADMAP.md` "Guiding principles").

- **Zero runtime dependencies.** `app.js`, `server.js`, `lib/`, `scripts/`, and
  `api/quotes.js` use only the Node.js / browser standard library. `package.json`
  has **no `dependencies`** — only `devDependencies` (ESLint, Playwright, Vercel
  CLI). Do not add a runtime dependency. Charts are hand-drawn SVG, not a
  charting library.
- **Static-first.** The dashboard must keep working as plain static files on
  GitHub Pages. Server / serverless features (`/api/quotes`, `/api/refresh`) are
  progressive enhancement — `app.js` silently no-ops when those endpoints are
  absent. Never make core rendering depend on a server.
- **Committed data is the source of truth.** Every data source is best-effort.
  The fetch script falls back Invesco -> FMP -> Slickcharts -> last-good-data so
  the cron job stays green and the site keeps working off the last snapshot.
  Preserve this.
- **No build step / no framework.** Plain HTML/CSS/JS, no bundler, ES modules
  (`"type": "module"`).
- **Informational, not advisory.** This is a data dashboard, never framed as
  trading or investment advice.

## Development workflow

Requires Node.js 20+ (`package.json` `engines`). `npm install` is needed once
for dev tooling; the app itself has nothing to install.

```bash
npm install          # dev tooling (ESLint, Playwright, Vercel CLI) — one time
npm start            # serve the dashboard at http://localhost:3000
npm run dev          # same, plus auto-refresh data every 30 min
npm run refresh      # run scripts/fetch-holdings.js once (writes data/*.json)
npm run lint         # eslint .
npm test             # unit + integration tests (node --test test/*.test.js)
npm run test:e2e     # Playwright browser smoke test (needs Chromium)
```

`npm start` / `refresh` load a gitignored `.env` automatically
(`--env-file-if-exists=.env`) — put `FMP_API_KEY=...` there for reliable data.

**Always run `npm run lint` and `npm test` before considering a change done.**
CI (`.github/workflows/ci.yml`) runs lint + unit tests + the e2e smoke test on
every push to `main` and every PR.

## Where code goes

- **New data-pipeline logic** (parsing, validation, transformation) belongs in
  `lib/` as a **pure function** — no network, no file I/O — so it is unit
  testable. `scripts/fetch-holdings.js` does the I/O and calls into `lib/`.
- **New quote-source logic** goes in `lib/quotes.js`, shared by both the local
  server and the Vercel function. `fetchQuotes` returns
  `{ source, quotes }` — keep that contract.
- **Frontend changes** go in `app.js` (browser-scoped in ESLint config) /
  `styles.css` / `index.html`. `app.js` is structured into commented sections
  (formatting, charts, rendering, data loading, events, boot).
- **`/api/quotes` changes must be mirrored** in both `server.js` and
  `api/quotes.js` — they intentionally serve the same payload shape.

## Data file schemas

`data/*.json` is a contract: `app.js`, `fetch-holdings.js`, and the API routes
all depend on these shapes. Changing them is a breaking change (reserved for
v2.0 per `ROADMAP.md`).

- **`holdings.json`** — `{ fund, name, legacyTicker, asOf, source, count,
  totalWeight, holdings: [{ ticker, name, sector, weight, price, changePct }] }`.
  `source` is one of `invesco`, `fmp`, `slickcharts`, `invesco-cached`,
  `fmp-cached`, `slickcharts-cached`, `seed`; `app.js` maps these to status
  badges.
- **`monthly-allocations.json`** — `{ fund, months: [...], allocations:
  { TICKER: { "YYYY-MM": weight } }, updatedAt }`. History capped at 24 months
  (`MAX_MONTHS`); `applyMonthlySnapshot` in `lib/holdings.js` owns this.
- **`changes.json`** — `{ events: [{ date, added: [...], removed: [...] }] }`,
  newest first, capped at 50 events.

The committed files ship a **sample dataset** (`source: "seed"`) so the
dashboard works before the first real cron run.

## Testing conventions

- Tests use the built-in `node:test` runner and `node:assert/strict` — no test
  framework dependency.
- `lib/` helpers get pure unit tests (`test/holdings.test.js`,
  `test/quotes.test.js`). Network is stubbed by replacing `globalThis.fetch`
  and restored in `afterEach` — tests must never hit the network.
- `server.js` and `api/quotes.js` have integration tests
  (`test/server.test.js`, `test/api-quotes.test.js`). `server.js` only calls
  `.listen()` when run directly, so tests can `import { server }` safely.
- `e2e/smoke.test.js` drives the real dashboard in headless Chromium. Set
  `CHROMIUM_PATH` if Playwright's managed browser download is unavailable.
- **Add tests with every `lib/` change.** New pipeline logic lands as a tested
  pure helper.

## Conventions & style

- ES modules everywhere (`import`/`export`); Node built-ins use the `node:`
  prefix.
- 2-space indentation, single quotes, semicolons (enforced by ESLint).
- Comments explain *why*, not *what* — the existing files are a good model:
  short, purpose-stating header comments and sparse inline notes for non-obvious
  behavior.
- Frontend: always `escapeHtml()` any holding-derived string interpolated into
  `innerHTML` (tickers/names come from external data) — see `app.js`.
- `npm audit` reports advisories — all from the dev-only Vercel CLI's transitive
  deps, none shipped to users. See `SECURITY.md`; do not "fix" them by
  downgrading the CLI.

## Git & PR workflow

- The default branch is `main`. CI, the refresh cron, and the Pages deploy all
  key off `main`.
- The data-refresh cron commits directly to `main` with messages like
  `data: refresh QQQQ holdings (<timestamp>)` — expect frequent data-only
  commits there.
- Make code changes on a feature branch and open a PR; CI must pass.
- A PR implementing a `ROADMAP.md` item should link back to the relevant
  section.
