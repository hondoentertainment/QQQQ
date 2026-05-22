# Security

## Reporting a vulnerability

This is a small, informational dashboard. If you find a security issue,
please open a GitHub issue with the details (or contact the maintainer
directly if you'd rather not disclose it publicly).

## Dependency audit (`npm audit`)

`npm audit` reports vulnerabilities for this project — **all of them in the
`vercel` CLI's transitive dependencies** (e.g. `undici`, `path-to-regexp`,
`tar`, `smol-toml`, `srvx`). This is expected, and it does **not** affect the
deployed application:

- **The shipped application has zero runtime dependencies.** The dashboard,
  the static server (`server.js`), the data scripts, and the Vercel
  `api/quotes.js` function all run on the Node.js standard library plus the
  project's own `lib/` code. None of the audited packages are bundled into
  what users actually run.
- **`vercel` is a dev-only dependency** (under `devDependencies`), used to
  preview and deploy from the command line. It never reaches production.
- There is no release of the Vercel CLI that `npm audit` reports as clean —
  the advisories live in packages the CLI bundles. `npm audit fix --force`
  only "resolves" them by downgrading the CLI several major versions, which
  is a regression, not a genuine fix.

CI (`npm ci`, `npm run lint`, `npm test`) does not run `npm audit`, so these
advisories do not block builds.

If you would rather not carry the CLI dependency at all, remove `vercel` from
`devDependencies` and deploy via Vercel's dashboard Git integration instead —
`vercel.json` already supports that, and `npm audit` then reports zero
vulnerabilities.
