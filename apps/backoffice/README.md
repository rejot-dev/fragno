# Backoffice

Backoffice is the Fragno dogfooding application. Its complete React Router server, Durable Objects,
and supporting Cloudflare bindings run in one Worker named `rejot-backoffice`.

## Development

From the repository root:

```bash
pnpm --dir apps/backoffice dev
```

## Deploy Backoffice

Backoffice deployment separates inactive version uploads from production activation. Give each
release a unique version tag; reusing a tag makes Cloudflare version selection ambiguous. The
package scripts pass flags directly to Wrangler, so do not insert a standalone `--` before them.

### Bootstrap the Worker

A normal deployment is required when creating the Worker or adding a declarative Durable Object
class that has not been provisioned yet:

```bash
BOOTSTRAP_TAG=bootstrap-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:bootstrap --tag "$BOOTSTRAP_TAG"
```

Bootstrap immediately activates the built Worker. It deliberately skips container rollout; manage
changes to `sandbox.Dockerfile` and the Sandbox container configuration separately. Use `--dry-run`
to validate the generated Worker locally without changing Cloudflare.

### Upload an inactive version

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload --tag "$VERSION_TAG"
```

This builds Backoffice and uploads one inactive `rejot-backoffice` version. The upload validates the
generated bundle and required remote secrets without changing production traffic.

For local validation without uploading:

```bash
pnpm --dir apps/backoffice run deploy:upload --tag "$VERSION_TAG" --dry-run
```

Upload dry runs do not validate remote secrets.

### Activate an uploaded version

Check that Cloudflare can resolve the tag without changing traffic:

```bash
pnpm --dir apps/backoffice run deploy --version-tag "$VERSION_TAG@100%" --yes --dry-run
```

Activate the tagged version at 100% traffic:

```bash
pnpm --dir apps/backoffice run deploy --version-tag "$VERSION_TAG@100%" --yes
```
