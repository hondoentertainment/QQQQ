# Roadmap — QQQQ Component Tracker

This document charts where the project is going. It is a living plan: items
move, get cut, or get reprioritized as the project evolves. Pull requests that
implement a roadmap item should link back to the relevant section.

> **What this project is.** A web dashboard for every component of QQQQ (the
> legacy ticker for the Invesco QQQ Trust / Nasdaq-100), with current weights,
> live prices, and month-by-month allocation history, kept fresh by a scheduled
> data-refresh job. See [`README.md`](README.md) for the full overview.

## Guiding principles

These constraints shape every item below. A proposal that breaks one of them
needs an explicit, recorded decision.

- **Zero runtime dependencies.** The dashboard, `server.js`, the data scripts,
  and `api/quotes.js` run on the Node.js standard library plus the project's
  own `lib/` code. New features should preserve this; a dependency must clear a
  high bar.
- **Static-first.** The dashboard must keep working as plain static files
  (GitHub Pages), with server/serverless features as progressive enhancement.
- **The committed data is the source of truth.** Features degrade gracefully
  when a live data source is unreachable — the cron job stays green and the
  site keeps working off the last good snapshot.
- **Tested and linted.** New pipeline logic lands as pure, unit-tested helpers
  in `lib/`; user-facing flows get e2e coverage. CI (`lint` + `test` + `e2e`)
  stays green.
- **Informational, not advisory.** This is a data dashboard, not a trading
  tool. Nothing here is investment advice.

## Current state — v1.2.0 (shipped)

The baseline this roadmap builds on:

- Sortable, filterable holdings table with fundamentals in detail rows.
- Monthly allocation history, compare overlay, weight-history chart (6/12/24 mo).
- Sector allocation (current) and **sector trends over time**.
- Today's movers, index-change banner + history, concentration trend, fund performance.
- Stale-data badge, `data/refresh-status.json` pipeline health in the footer.
- **Interactive chart hovers** (SVG `<title>` tooltips on all trend charts).
- **Offline / error banner** when JSON fails to load or the browser is offline.
- **PWA shell** — `manifest.json` + service worker for last-good snapshot caching.
- Shareable URL state, light/dark theme, responsive card layout, accessibility pass.
- Data pipeline: Invesco → FMP → **SEC N-PORT** → cached/seed fallback chain.
- **Schema validation** on write (`validateHoldingsDocument`, etc.).
- Cron failure alerting (GitHub issue auto-open/close on fallback).
- Schema versioning on all `data/*.json` documents.
- [`DATA_CONTRACT.md`](DATA_CONTRACT.md) for committed JSON and `/api/quotes`.
- Unit tests (validators, SEC mapping), expanded e2e (sort, filter, CSV, charts, visual bounds).
- **Performance budget** CI step (`npm run check:bundle`).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for the `lib/` + test workflow.

## How to read the phases

Phases are ordered by dependency and priority, not by hard dates. Within each
phase, items are roughly ordered by value-to-effort. The **Now / Next / Later**
summary at the end is the quick reference.

---

## Phase 1 — Harden the data pipeline (Ongoing)

Most Phase 1 items are shipped. Remaining work:

- **Valid FMP API key in production.** Both GitHub Actions and Vercel need
  `FMP_API_KEY` when Invesco blocks automated CSV downloads. Until the key
  authorizes ETF holdings, the pipeline falls back to SEC N-PORT or seed data.
- **SEC N-PORT freshness.** N-PORT filings lag daily Invesco data; prefer Invesco
  or FMP when reachable. Monitor mapping quality when constituents change names.
- **Backfill guard documentation.** Same-month `applyMonthlySnapshot` re-runs
  update weights in place — now tested; document `MAX_MONTHS` retention in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Phase 2 — Analytics & visualization (Shipped in v1.2)

All planned v1.x chart work is shipped. Future ideas live in Phase 4.

## Phase 3 — UX, accessibility & performance (Mostly shipped)

Shipped:

- Light/dark theme, shareable URL state, mobile card layout, skip link, live region.
- Stale-data indicator, methodology panel, delayed-quote labelling.
- Empty / error / offline states and PWA offline cache.

Remaining:

- **Table virtualization.** If render cost grows, virtualize the ~100-row table.
- **Accessibility audit.** Run axe, verify contrast and focus order beyond the
  current manual pass.

## Phase 4 — Real-time depth & richer metrics (Later)

- **Server-Sent Events for prices.** SSE stream from `server.js` when self-hosted.
- **More per-component metrics.** Volume, beta, dividend yield where sources provide them.
- **Intraday price sparklines** during market hours.
- **Configurable refresh cadence** documented and validated.

## Phase 5 — Platform, distribution & alerts (Later)

- **Embeddable widget.** Compact top-10 iframe view.
- **Watchlist & alerts.** Local star tickers; optional notifications for index changes.

## Phase 6 — Quality, ops & docs (Ongoing)

Shipped:

- Expanded e2e beyond smoke (sort, filter, CSV, chart panels, visual bounds).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and `scripts/sync-vercel-env.mjs`.
- Performance budget CI and [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

Remaining:

- **GitHub Pages one-time setup.** Settings → Pages → GitHub Actions (workflow
  skips gracefully until configured).
- **Committed screenshot baselines** for stricter visual regression (optional).

---

## Now / Next / Later

| Horizon   | Focus                              | Phases |
|-----------|------------------------------------|--------|
| **Now**   | Valid FMP key, GitHub Pages setup  | 1, 6   |
| **Next**  | Accessibility audit, table virt.   | 3      |
| **Later** | SSE prices, embeddable widget      | 4, 5   |
| **Ongoing** | Pipeline monitoring, tests, ops  | 1, 6   |

## Versioning

The project follows semantic versioning (`package.json` `version`).

- **v1.x** — incremental features that don't break the `data/*.json` contract.
- **v2.0** — reserved for a breaking change to the `data/*.json` schema or the
  `/api/quotes` contract (paired with a `SCHEMA_VERSION` bump).

## Non-goals

Deliberately out of scope, to keep the project focused:

- **Trading, brokerage, or portfolio features.**
- **Tick-level streaming market data.**
- **A heavy frontend framework or build step.**
- **User accounts or a backend database.**
- **Coverage of ETFs other than QQQ/QQQQ.**

## Contributing to the roadmap

Open a GitHub issue to propose, reprioritize, or challenge an item. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow.
