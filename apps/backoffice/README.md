# Backoffice

Backoffice is the Fragno dogfooding application. It is a React Router application deployed as an
entry Cloudflare Worker with route-specific Workers connected through service bindings.

## Development

From the repository root:

```bash
pnpm --dir apps/backoffice dev
```

## Deploy Backoffice

Backoffice deployment has separate upload and activation steps. Use one unique version tag for all
Workers in a release. Do not reuse a tag: Cloudflare cannot resolve a tag that matches multiple
versions of the same Worker.

### Bootstrap new Workers once

`wrangler versions upload` cannot create a Worker. Before the first versioned release, use Wrangler
manually to create and configure any secret-bearing Workers, including
`rejot-backoffice-routes-api`. Then bootstrap the complete Worker topology with normal deployments:

```bash
BOOTSTRAP_TAG=bootstrap-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:bootstrap -- --tag "$BOOTSTRAP_TAG"
```

The bootstrap command performs immediate `wrangler deploy` operations in route-Worker order and
deploys the entry Worker last. It is a one-time live deployment, not an inactive version upload. Use
`--dry-run` to validate the bootstrap locally without creating Workers. Bootstrap dry runs do not
validate remote secrets.

### 1. Upload inactive Worker versions

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG"
```

This command builds Backoffice and runs `wrangler versions upload` for every route Worker followed
by the entry Worker. The upload validates the generated bundles and required remote secrets without
activating the versions.

For local build validation without uploading versions:

```bash
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG" --dry-run
```

Upload dry runs do not check whether required secrets exist on the remote Workers.

To upload only one Worker, select its topology id with `--worker`. Use `entry` for the entry Worker:

```bash
pnpm --dir apps/backoffice run deploy:upload -- \
  --tag "$VERSION_TAG" \
  --worker internals
```

The same selector works with `deploy:bootstrap` and `deploy`.

### 2. Deploy the uploaded versions

To check that every Worker has a deployable version with the tag without changing production:

```bash
pnpm --dir apps/backoffice run deploy -- --tag "$VERSION_TAG" --dry-run
```

Activate the tagged versions at 100% traffic:

```bash
pnpm --dir apps/backoffice run deploy -- --tag "$VERSION_TAG"
```

The deploy command checks every Worker tag before activating any version. It then deploys the route
Workers in topology order and the entry Worker last. Activation is not atomic across Workers: if a
deployment fails after activation begins, Workers already activated remain on the new version.

### Container changes

The version upload/deploy flow does not publish or roll out changes to `sandbox.Dockerfile` or the
Sandbox container configuration. Treat container changes as a separate deployment operation.
