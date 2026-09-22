# Backoffice

Backoffice deploys as three Cloudflare Workers:

- `rejot-codemode-compiler` owns the stateless TypeScript and esbuild service.
- `rejot-backoffice` owns the Durable Objects and backend bindings.
- `rejot-backoffice-web` is the public React Router Worker.

## Build outputs

`pnpm --dir apps/backoffice build` produces:

```text
dist/rejot_codemode_compiler/wrangler.json # rejot-codemode-compiler
dist/rejot_backoffice/wrangler.json        # rejot-backoffice
build/server/wrangler.json                  # rejot-backoffice-web
```

React Router owns the primary Worker build under `build/server`. Cloudflare's Vite plugin builds the
compiler and object host as independent auxiliary Worker module graphs under `dist`.

Use these generated configs for uploads. They point to compiled bundles where Vite has resolved
virtual modules and raw asset imports. The source configs, `wrangler.compiler.jsonc`,
`wrangler.jsonc`, and `wrangler.web.jsonc`, are sufficient when activating versions because
activation does not rebuild the source.

## Release

Upload an inactive version of all Workers with one shared tag:

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG"
```

Activate the tagged versions in dependency order: compiler, object host, then web Worker:

```bash
pnpm --dir apps/backoffice run deploy -- \
  --version-tag "$VERSION_TAG@100%" \
  --yes
```

The three activations are sequential, so releases must remain compatible during the rollout.
