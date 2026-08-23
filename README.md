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

## Important

Do not expose the D1 database publicly. The Pages Function is the only interface.

If you change the app later, push to GitHub and Cloudflare Pages will redeploy automatically.
