# How to profile Backoffice Worker startup CPU

Build and profile both production Worker bundles from the repository root:

```bash
pnpm --filter @fragno-apps/backoffice-rr startup:profile
pnpm --filter @fragno-apps/backoffice-rr startup:profile -- --worker objects --runs 8
```

Keep the CPU profiles to open them in Chrome DevTools or VS Code:

```bash
pnpm --filter @fragno-apps/backoffice-rr startup:profile -- --profile-dir /tmp/backoffice-startup
```

Single runs vary by tens of milliseconds, so compare medians between revisions. Local values are
lower than the `Worker Startup Time` Wrangler prints on upload, which Cloudflare measures on its own
hardware.

## Why not `wrangler check startup --config`

`wrangler check startup` ignores `--config` and follows the Cloudflare Vite plugin's
`.wrangler/deploy/config.json` redirect, so it always profiles the web Worker, even when pointed at
`dist/rejot_backoffice/wrangler.json`. The script writes each Worker's exact upload with
`wrangler deploy --dry-run --outfile` and profiles that file with `wrangler check startup --worker`.

The profile covers module evaluation only. Dynamically imported chunks run on first use, so their
cost shows up in requests, not here.
