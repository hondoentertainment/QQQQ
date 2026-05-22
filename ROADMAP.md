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

## Current state — v1.0.0 (shipped)

The baseline this roadmap builds on:

- Sortable, filterable holdings table — ticker, company, sector, index weight,
  live price, day move.
- Monthly allocation history with 6-month sparklines and per-row detail.
- Index-change tracking (additions/removals) surfaced in a banner.
- Fund-wide sector allocation breakdown.
- Near-real-time prices: 60s view refresh + 20s server/serverless quote poll.
- CSV export of the current filtered/sorted view with monthly history.
- Keyboard-accessible table (`aria-sort` / `aria-expanded`).
- Data pipeline with Invesco → FMP → last-good-data fallback.
- Unit tests (`test/`), Playwright smoke test (`e2e/`), CI workflow.
- Scheduled refresh cron, GitHub Pages deploy, Vercel deploy + `/api/quotes`.

## How to read the phases

Phases are ordered by dependency and priority, not by hard dates. Within each
phase, items are roughly ordered by value-to-effort. The **Now / Next / Later**
summary at the end is the quick reference.

---

## Phase 1 — Harden the data pipeline (Now)

The data pipeline is the foundation; everything else trusts its output. This
phase makes refreshes more reliable, observable, and recoverable.

- **Refresh observability.** Have `scripts/fetch-holdings.js` emit a structured
  run summary (source used, holdings count, quote success rate, fallbacks hit)
  and write it to a `data/refresh-status.json`. Surface "last refresh" health
  in the dashboard footer instead of just a timestamp.
- **Cron failure alerting.** When `refresh.yml` falls all the way back to
  last-good-data, or a run fails outright, open/update a GitHub issue (or fail
  the job loudly) so a stale dashboard is noticed.
- **Additional holdings fallback source.** Add one more independent holdings
  source behind the existing Invesco → FMP chain, so a single provider outage
  doesn't force a stale snapshot. Lands as a tested parser in `lib/holdings.js`.
- **Stale-data badge.** When the newest snapshot is older than a threshold
  (e.g. one trading day), show a clear "data may be stale" indicator in the UI.
- **Schema versioning for `data/*.json`.** Add a `schemaVersion` field and a
  validation step so future shape changes are explicit and migratable.
- **Backfill guard for monthly allocations.** Make `applyMonthlySnapshot`
  idempotent across same-month re-runs and document the 24-month retention
  (`MAX_MONTHS`) behavior in tests.

## Phase 2 — Analytics & visualization (Next)

With trustworthy data, make the dashboard genuinely insightful rather than just
a table.

- **Top movers panel.** Biggest day gainers/losers and biggest
  month-over-month weight changes, computed in a pure `lib/` helper.
- **Weight-history chart.** Promote the per-row sparkline to a full
  interactive chart (hand-drawn SVG/Canvas — no charting dependency) with
  hover values and a selectable window (6 / 12 / 24 months).
- **Sector trends over time.** Show how sector allocation has shifted across
  the monthly history, not just the current snapshot.
- **Concentration metrics.** Top-10 weight share and a simple concentration
  index (e.g. Herfindahl) as headline cards — a recognized concern for QQQ.
- **Compare components.** Select two or more tickers and overlay their
  weight/price history.
- **Index-change history view.** A browsable timeline of constituent
  additions/removals from `data/changes.json`, not just the latest banner.

## Phase 3 — UX, accessibility & performance (Next)

Polish the experience and make it fast on every device.

- **Light/dark theme** honoring `prefers-color-scheme`, with a manual toggle
  persisted to `localStorage`.
- **Shareable URL state.** Encode sort, filter, sector, and open rows in the
  URL query string so a view can be linked and restored.
- **Mobile layout pass.** A responsive card/list layout for the holdings table
  on narrow screens, replacing horizontal scroll.
- **Table performance.** If render cost grows, virtualize the ~100-row table
  so sort/filter stays smooth on low-end devices.
- **Accessibility audit.** Run an axe pass, verify focus order and contrast,
  add a skip link, and confirm the screen-reader experience for expandable
  rows and live regions for price updates.
- **Empty / error / offline states.** Explicit, friendly UI for "no data yet",
  "refresh failed", and offline rather than silent blanks.

## Phase 4 — Real-time depth & richer metrics (Later)

Deeper market data, where it can be done within the project's constraints.

- **Server-Sent Events for prices.** Replace the 20s `/api/quotes` poll with an
  SSE stream from `server.js` for smoother updates when self-hosted; the static
  build keeps the existing poll/no-op path.
- **More per-component metrics.** Market cap, P/E, volume, and 52-week range
  where a data source provides them — additive columns, gracefully blank when
  unavailable.
- **Intraday price history.** A small intraday sparkline per component during
  market hours, sourced from the quote provider.
- **Configurable refresh cadence.** Surface `REFRESH_MINUTES` / cron cadence as
  documented, validated configuration.

## Phase 5 — Platform, distribution & alerts (Later)

Turn the dashboard into something others can build on and subscribe to.

- **PWA / offline support.** A service worker and manifest so the last good
  snapshot is viewable offline and installable.
- **Documented public data contract.** Treat `data/*.json` and `/api/quotes`
  as a versioned, documented read-only API others can consume.
- **Embeddable widget.** A compact, iframe-friendly view (e.g. top-10 holdings)
  for embedding in other pages.
- **Watchlist & alerts.** Let a visitor star tickers (stored locally) and,
  optionally, opt into notifications for large weight changes or
  index additions/removals.

## Phase 6 — Quality, ops & docs (Ongoing)

Cross-cutting work that runs alongside every phase.

- **Coverage growth.** Expand unit tests with each `lib/` change; add e2e cases
  for sort, filter, CSV export, and row expansion beyond the current smoke test.
- **Visual-regression check.** Screenshot diffing in the e2e job to catch
  unintended UI changes.
- **Dependency hygiene.** Keep dev dependencies current; keep runtime
  dependency count at zero. Revisit whether the Vercel CLI dev dependency still
  earns its place (see [`SECURITY.md`](SECURITY.md)).
- **Performance budget.** Track and cap the static bundle size and dashboard
  load time.
- **Contributor docs.** A `CONTRIBUTING.md` covering the `lib/` + tests
  workflow, plus architecture notes for the data pipeline.

---

## Now / Next / Later

| Horizon   | Focus                              | Phases |
|-----------|------------------------------------|--------|
| **Now**   | Reliable, observable data pipeline | 1      |
| **Next**  | Insightful analytics, polished UX  | 2, 3   |
| **Later** | Real-time depth, platform, alerts  | 4, 5   |
| **Ongoing** | Tests, ops, docs                 | 6      |

## Versioning

The project follows semantic versioning (`package.json` `version`).

- **v1.x** — current line: incremental Phase 1–3 features that don't change the
  `data/*.json` contract.
- **v2.0** — reserved for a breaking change to the `data/*.json` schema or the
  `/api/quotes` contract (paired with the Phase 1 `schemaVersion` work).

## Non-goals

Deliberately out of scope, to keep the project focused:

- **Trading, brokerage, or portfolio features.** This is an informational
  dashboard, not a trading tool.
- **Tick-level streaming market data.** True real-time feeds require a paid
  market-data provider; cron + polling/SSE is the intended ceiling.
- **A heavy frontend framework or build step.** The dashboard stays plain
  HTML/CSS/JS with no bundler.
- **User accounts or a backend database.** State stays in committed JSON and
  the visitor's `localStorage`.
- **Coverage of ETFs other than QQQ/QQQQ.** Tracking the Nasdaq-100 keeps the
  data pipeline simple and the scope clear.

## Contributing to the roadmap

Open a GitHub issue to propose, reprioritize, or challenge an item. Keep
proposals concrete (what changes, in which files, with what tests) and check
them against the guiding principles above.
