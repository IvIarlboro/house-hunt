# House Hunt

A private house tracker published with GitHub Pages from `docs/`.
Everything under `docs/data/` except `meta.json` is AES-GCM encrypted with a family passphrase,
so the public site shows only a lock screen to anyone without it.

- `scripts/refresh.mjs` runs every 10 minutes on the home PC. It reads the listing portal over plain HTTP,
  fetches details only for new, changed or stale listings, and commits `docs/data/listings.enc.json`
  only when something changed. The portal link and passphrase live outside the repo.
- `docs/app.js` decrypts in the browser, scores each house with adjustable weights, and saves ratings,
  notes and people to `docs/data/shared.enc.json` through the GitHub API with a shared write token
  that is itself stored encrypted in `docs/data/token.enc.json`.
- Local preview: `node scripts/serve.mjs`, then open http://localhost:5178.
