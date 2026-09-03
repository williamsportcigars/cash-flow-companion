# Cash Flow Companion — Cloudflare + GitHub edition

This version is designed for:
- GitHub repository as the source
- Cloudflare Pages for the web app
- Cloudflare D1 for persistent cloud storage
- Cloudflare Access for account identity

## Deploy

1. Create a GitHub repository, e.g. `cash-flow-companion`.
2. Upload the contents of this folder to the repository.
3. In Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git.
4. Select the repository.
5. Framework preset: None.
6. Build command: leave blank.
7. Build output directory: `public`.
8. Deploy.
9. Create a D1 database named `cash-flow-companion`.
10. Add a Pages D1 binding named `DB` pointing to that database.
11. Run `schema.sql` against the D1 database.
12. Protect the deployed site with Cloudflare Access (one-time setup). Access will supply the authenticated email header used as the user's data key.

## Reconcile from bank screenshots

The **Reconcile** button (top bar) reads screenshots of a bank account and
matches what it finds against that account's calendar. Flow:

- The browser downscales the images and POSTs them to `POST /api/reconcile`.
- The Worker runs a Cloudflare Workers AI vision model (`RECONCILE_MODEL` in
  `src/index.js` — currently Llama 3.2 11B Vision; needs the `ai` binding in
  `wrangler.jsonc`) once per image and returns the transactions + balances it
  can read. No database write happens here.
- The browser matches those against the account's events (vendor-name decoder
  + amount/date/description scoring), proposes what to confirm, add, or flag,
  and checks the total against the bank's posted balance.
- **Apply** writes through the normal `PUT /api/state`, which snapshots
  history first, so it can be undone from **History**.

Workers AI usage for this is well within the free daily allocation. Screenshots
are sent to Workers AI to read the text and are not stored. The first call to
the Llama vision model needs a one-time Meta license acceptance — the Worker
attempts this automatically; if it fails, open that model once in the Cloudflare
Workers AI Playground and accept the terms.

## Important

Do not expose the D1 database publicly. The Pages Function is the only interface.

If you change the app later, push to GitHub and Cloudflare Pages will redeploy automatically.
