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

## Current state — v1.1.0 (shipped)

The baseline this roadmap builds on:

- Sortable, filterable holdings table with fundamentals in detail rows.
- Monthly allocation history, compare overlay, weight-history chart (6/12/24 mo).
- Sector allocation (current) and **sector trends over time**.
- Today's movers, index-change banner + history, concentration trend, fund performance.
- Stale-data badge, `data/refresh-status.json` pipeline health in the footer.
- Shareable URL state, light/dark theme, responsive card layout, accessibility pass.
- Data pipeline: Invesco → FMP → **SEC N-PORT** → cached/seed fallback chain.
- Cron failure alerting (GitHub issue auto-open/close on fallback).
- Schema versioning on all `data/*.json` documents.
- Unit tests, expanded e2e (sort, filter, CSV export, charts), CI workflow.
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
- **Schema validation step.** `schemaVersion` is stamped on write; add an explicit
  read-time validation pass in `fetch-holdings.js` before commit.
- **Backfill guard documentation.** Same-month `applyMonthlySnapshot` re-runs
  update weights in place — now tested; document `MAX_MONTHS` retention in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Phase 2 — Analytics & visualization (Mostly shipped)

Shipped in v1.1:

- Top movers panel, compare holdings, Herfindahl card, concentration trend.
- Weight-history chart with selectable 6/12/24-month window.
- Sector trends over time (top 5 sectors across monthly history).
- Index-change history view.

Remaining:

- **Interactive chart hovers.** Show exact values on hover for weight/sector charts
  (title attributes or a lightweight tooltip div — still no charting dependency).

## Phase 3 — UX, accessibility & performance (Mostly shipped)

Shipped:

- Light/dark theme, shareable URL state, mobile card layout, skip link, live region.
- Stale-data indicator, methodology panel, delayed-quote labelling.

Remaining:

- **Table virtualization.** If render cost grows, virtualize the ~100-row table.
- **Empty / error / offline states.** Explicit UI when JSON fails to load or the
  browser is offline.
- **Accessibility audit.** Run axe, verify contrast and focus order beyond the
  current manual pass.

## Phase 4 — Real-time depth & richer metrics (Later)

- **Server-Sent Events for prices.** SSE stream from `server.js` when self-hosted.
- **More per-component metrics.** Volume, beta, dividend yield where sources provide them.
- **Intraday price sparklines** during market hours.
- **Configurable refresh cadence** documented and validated.

## Phase 5 — Platform, distribution & alerts (Later)

- **PWA / offline support.** Service worker + manifest for last-good snapshot.
- **Documented public data contract.** Version `data/*.json` and `/api/quotes`.
- **Embeddable widget.** Compact top-10 iframe view.
- **Watchlist & alerts.** Local star tickers; optional notifications for index changes.

## Phase 6 — Quality, ops & docs (Ongoing)

Shipped:

- Expanded e2e beyond smoke (sort, filter, CSV, chart panels).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and `scripts/sync-vercel-env.mjs`.

Remaining:

- **Visual-regression check.** Screenshot diffing in the e2e job.
- **Performance budget.** Cap static bundle size and dashboard load time.
- **GitHub Pages one-time setup.** Settings → Pages → GitHub Actions (workflow
  skips gracefully until configured).

---

## Now / Next / Later

| Horizon   | Focus                              | Phases |
|-----------|------------------------------------|--------|
| **Now**   | Valid FMP key, GitHub Pages setup  | 1, 6   |
| **Next**  | Chart hovers, offline/error states | 2, 3   |
| **Later** | SSE prices, PWA, platform APIs     | 4, 5   |
| **Ongoing** | Pipeline validation, tests, ops  | 1, 6   |

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
