# Backoffice

Backoffice deploys as two Cloudflare Workers:

- `rejot-backoffice-web` is the public React Router Worker.
- `rejot-backoffice` owns the Durable Objects and backend bindings.

## Build outputs

`pnpm --dir apps/backoffice build` produces:

```text
build/server/wrangler.json                 # rejot-backoffice-web
dist/rejot_backoffice/wrangler.json        # rejot-backoffice
```

React Router owns the primary Worker build under `build/server`. Cloudflare's Vite plugin builds
`rejot-backoffice` as an auxiliary Worker under `dist/rejot_backoffice`.

Use these generated configs for uploads. They point to compiled bundles where Vite has resolved
virtual modules and raw asset imports. The source configs, `wrangler.web.jsonc` and
`wrangler.jsonc`, are sufficient when activating versions because activation does not rebuild the
source.

## Release

When a release adds a Durable Object class, an inactive upload cannot provision its namespace.
Bootstrap that release instead:

```bash
pnpm --dir apps/backoffice run deploy:bootstrap
```

Bootstrap builds and **activates** the object Worker first to provision its classes, then activates
the web Worker. It skips container image rollout (`--containers-rollout=none`); deploy container
changes separately if the release requires them. This is a live release, not an inactive upload.

For releases without new Durable Object classes, upload an inactive version of both Workers with one
shared tag:

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG"
```

Activate the tagged versions, web Worker first and object Worker second:

```bash
pnpm --dir apps/backoffice run deploy -- \
  --version-tag "$VERSION_TAG@100%" \
  --yes
```

The two activations are sequential, so releases must remain compatible during the rollout.
