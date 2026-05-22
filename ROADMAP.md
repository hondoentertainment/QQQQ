# Roadmap — QQQQ Component Tracker

See [`README.md`](README.md) for the project overview.

## Current state — v1.3.0 (shipped)

- All v1.2 features plus:
- **SEC name overrides** (`data/name-overrides.json`) and unmapped-name tracking in refresh status.
- **Data quality & provenance** footer lines; visit digest banner.
- **Watchlist** (localStorage), fund contribution on movers, concentration alerts.
- **Skeleton loading**, CSS chart tooltips, keyboard shortcut dialog (`?`, `w`, `Esc`).
- **SEO/distribution**: Open Graph, JSON-LD, `sitemap.xml`, `robots.txt`, **`embed.html`** top-10 widget.
- **Ops**: hourly production health workflow, post-merge smoke test, axe a11y e2e.
- **`lib/analytics.js`** shared pure helpers (contributions, quality warnings, provenance).

## Now / Next / Later

| Horizon | Focus |
|---------|-------|
| **Now** | Valid FMP API key, GitHub Pages setup, fix Invesco bot block |
| **Next** | Full WCAG color-contrast pass, intraday sparklines, custom domain |
| **Later** | SSE prices, PWA push alerts, saved named views |

## Non-goals

Trading features, tick streaming, heavy frameworks, user accounts, other ETFs.

See prior phases in git history (`ROADMAP.md` v1.2) for the full phased plan.
