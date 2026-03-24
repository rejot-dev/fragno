# GitHub App Fragment (@fragno-dev/github-app-fragment)

## Summary

GitHub App integration fragment with built-in app authentication, webhook ingestion,
installation/repository sync, and pull-request actions.

## Use when

- Your product needs GitHub App auth without hand-rolling JWT/installation token logic.
- You want to track installations and repositories from webhooks.
- You need repo-aware product features such as sync, linking, and pull-request operations.

## Config

The fragment config defines your GitHub App credentials and optional webhook handlers.

What you provide:

- `appId`: GitHub App ID.
- `appSlug`: GitHub App slug.
- `privateKeyPem`: GitHub App private key contents.
- `webhookSecret`: webhook signing secret.
- `webhookDebug` (optional): verbose webhook logging.
- `apiBaseUrl`, `apiVersion`, `webBaseUrl` (optional): GitHub API/web overrides.
- `defaultLinkKey` (optional): default key for repo linking.
- `tokenCacheTtlSeconds` (optional): installation token cache TTL.
- `webhook` (optional): register typed webhook handlers.

What the fragment needs via options:

- `databaseAdapter`: required for installations, repository links, and sync state.
- `mountRoute` (optional): choose where the fragment is mounted.

## What you get

- GitHub App JWT + installation access token handling.
- Webhook-driven installation and repository tracking.
- Routes for listing installations/repos, syncing, linking repositories, and PR review actions.
- A small typed client hook surface plus public services for the raw app/client.

## Docs

There is not yet a published Markdown docs section for this fragment. Use these local references
first:

- `apps/docs/app/routes/github.tsx`
- `packages/github-app-fragment/README.md`
- `packages/github-app-fragment/src/github/factory.ts`
- `packages/github-app-fragment/src/github/clients.ts`
- `packages/github-app-fragment/src/github/types.ts`

## Prerequisites

- A GitHub App created in GitHub settings.
- The app configured with pull-request + metadata permissions and installation webhooks.
- A database and `@fragno-dev/db` adapter.
- A public webhook endpoint reachable by GitHub.

## Install

`npm install @fragno-dev/github-app-fragment @fragno-dev/db`

## Server setup

1. Create/configure the GitHub App in GitHub.
2. Instantiate the fragment with app credentials.
3. Optionally register webhook handlers for installation lifecycle events.
4. Mount routes in your framework.
5. Configure the GitHub App webhook URL to the mounted webhook route.
6. Generate and apply DB migrations.

Example server module:

```ts
import {
  createGitHubAppFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";
import { databaseAdapter } from "./db";

const config: GitHubAppFragmentConfig = {
  appId: process.env.GITHUB_APP_ID ?? "",
  appSlug: process.env.GITHUB_APP_SLUG ?? "",
  privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
  webhook: (register) => {
    register("installation.deleted", async (event, idempotencyKey) => {
      console.log("GitHub installation deleted", event.payload.installation?.id, idempotencyKey);
    });
  },
};

export const githubFragment = createGitHubAppFragment(config, {
  databaseAdapter,
  mountRoute: "/api/github",
});
```

## Database migrations

Generate schema/migrations:

- `npx fragno-cli db generate lib/github.ts --format drizzle -o db/github.schema.ts`
- `npx fragno-cli db generate lib/github.ts --output migrations/001_github.sql`

## Client setup

Use the framework-specific client entrypoint, e.g. React:

```ts
import { createGitHubAppFragmentClient } from "@fragno-dev/github-app-fragment/react";

export const githubClient = createGitHubAppFragmentClient({
  mountRoute: "/api/github",
});
```

Today the built-in client surface is intentionally small:

- `useSyncInstallation`

For other routes, create app-level wrappers or call the routes from your server/UI as needed.

## Routes

- `POST /webhooks`
- `GET /installations`
- `GET /installations/:installationId/repos`
- `POST /installations/:installationId/sync`
- `GET /repositories/linked`
- `POST /repositories/link`
- `POST /repositories/unlink`
- `GET /repositories/:owner/:repo/pulls`
- `POST /repositories/:owner/:repo/pulls/:number/reviews`

## Security notes

- Keep the private key and webhook secret out of client bundles.
- Protect sync/link/review routes with your own app auth/authorization.
- Make sure the GitHub App webhook URL matches the mounted fragment route.

## Common pitfalls

- Using the wrong webhook URL or secret, so signature verification fails.
- Forgetting required GitHub App permissions or webhook subscriptions.
- Assuming the built-in client wraps every route; some routes are intended for app-level wrappers.

## Next steps

- Map GitHub installations and linked repos into your product's org/project model.
- Add webhook handlers to trigger product-specific sync and automation.
