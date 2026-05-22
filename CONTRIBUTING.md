# Contributing to QQQQ Component Tracker

Thanks for helping improve the dashboard and data pipeline. This project
intentionally stays **zero runtime dependencies** — keep new logic in tested
`lib/` helpers and plain HTML/CSS/JS.

## Getting started

```bash
npm install
npm start                 # dashboard at http://localhost:3000
npm run refresh           # refresh data/*.json once
npm run lint
npm test
npm run test:e2e          # needs: npx playwright install chromium
```

Optional: create a `.env` file (gitignored) with `FMP_API_KEY=...` for reliable
holdings and quotes locally. The npm scripts load it automatically.

## Project layout

| Path | Purpose |
|------|---------|
| `lib/holdings.js` | Pure data-pipeline parsers and validators |
| `lib/quotes.js` | Shared live-quote fetching |
| `scripts/fetch-holdings.js` | Refresh job — writes all `data/*.json` |
| `app.js` | Dashboard UI |
| `test/*.test.js` | Unit tests |
| `e2e/*.test.js` | Browser smoke / interaction tests |

## Making pipeline changes

1. Add or extend a **pure helper** in `lib/` (no network, no I/O).
2. Unit-test it in `test/holdings.test.js` or `test/quotes.test.js`.
3. Wire it from `scripts/fetch-holdings.js`.
4. Run `npm test` and `npm run lint`.

Holdings sources (in order):

1. Invesco official CSV
2. Financial Modeling Prep (requires `FMP_API_KEY`)
3. SEC N-PORT filing (maps company names to tickers via the prior snapshot)
4. Last-good cached / seed data

Each refresh writes `data/refresh-status.json` with the source chain,
quote success rate, and fallback flag.

## Making UI changes

- Match existing patterns in `app.js` and `styles.css`.
- Prefer hand-drawn SVG charts — no charting libraries.
- Keep the table DOM stable; e2e tests count rows and exercise sort/filter/export.
- Run `npm run test:e2e` for user-facing flows.

## Deployment notes

### GitHub Actions secrets

- `FMP_API_KEY` — recommended for Invesco/FMP holdings and FMP quotes.

### Vercel environment variables

Add the same key for production `/api/quotes`:

```bash
# With FMP_API_KEY set in your shell or .env:
node scripts/sync-vercel-env.mjs
npx vercel deploy --prod
```

### GitHub Pages

One-time repo setup: **Settings → Pages → Source: GitHub Actions**. The
`pages.yml` workflow skips deploy gracefully when Pages is not yet configured.

## Pull requests

- Keep diffs focused; one feature or fix per PR when possible.
- Ensure CI is green (`lint`, `test`, `e2e`).
- Link roadmap items from `ROADMAP.md` when relevant.
- Do not commit secrets, `.env`, or personal API keys.

## Versioning

- Bump `package.json` `version` for releases (semver).
- Bump `SCHEMA_VERSION` in `lib/holdings.js` only when `data/*.json` shape
  changes incompatibly (reserved for v2.0).
