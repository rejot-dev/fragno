# github-app-fragment

A Fragno fragment that integrates a GitHub App using installation-only authentication. Includes a
CLI to run a local server and call all fragment routes for integration testing.

## Features

- JWT + installation access token auth
- Webhook-driven installation and repository tracking
- Explicit repo linking for access control
- Pull request listing + review creation
- CLI for serving and exercising all routes

## GitHub App Setup (UI)

1. Go to GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **GitHub App name** (any unique name)
   - **Homepage URL** (can be your project URL)
   - **Webhook URL**: use your tunnel URL + `/api/github-app-fragment/webhooks`
   - **Webhook secret**: set a random secret (keep it)
3. Permissions (Repository):
   - **Pull requests**: Read & write
   - **Metadata**: Read-only (default)
4. Subscribe to webhook events:
   - `installation`
   - `installation_repositories`
5. Generate a **private key** and download the `.pem` file.
6. Install the App on the repositories you want to test with.

### Generating the PEM private key

1. Open your GitHub App settings page.
2. Scroll to **Private keys**.
3. Click **Generate a private key**.
4. Download the `.pem` file and store it securely.

## Environment

```bash
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-github-app
GITHUB_APP_PRIVATE_KEY_FILE=./my-github-app.private-key.pem
GITHUB_APP_WEBHOOK_SECRET=super-secret
# Optional
GITHUB_APP_API_BASE_URL=https://api.github.com
GITHUB_APP_API_VERSION=2022-11-28
GITHUB_APP_WEB_BASE_URL=https://github.com
GITHUB_APP_DEFAULT_LINK_KEY=default
GITHUB_APP_TOKEN_CACHE_TTL_SECONDS=3300
```

If you use `GITHUB_APP_PRIVATE_KEY`, store it as a single line with `\n` escapes.

## CLI (Local Integration Testing)

Build once:

```bash
pnpm exec turbo build --filter=@fragno-dev/github-app-fragment --output-logs=errors-only
```

Start a local server (SQLite):

```bash
pnpm exec fragno-github-app serve --port 6173
```

Use a custom SQLite path:

```bash
pnpm exec fragno-github-app serve --db-path ./github-app.sqlite
```

Expose it with your tunnel and set the GitHub App webhook URL to:

```
https://<tunnel-host>/api/github-app-fragment/webhooks
```

Call routes from the CLI:

```bash
export FRAGNO_GITHUB_APP_BASE_URL=http://localhost:6173/api/github-app-fragment

pnpm exec fragno-github-app installations list
pnpm exec fragno-github-app installations repos --installation-id <id>
pnpm exec fragno-github-app repositories link --installation-id <id> --repo-id <repo>
pnpm exec fragno-github-app pulls list --owner <owner> --repo <repo>
```

Send a signed webhook payload (optional):

```bash
pnpm exec fragno-github-app webhooks send \
  --event installation \
  --installation-id <id> \
  --payload '{"installation":{"id":"<id>"},"action":"created"}'
```

## Server Usage (Framework Integration)

```ts
import {
  createGitHubAppFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";
import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";

const config: GitHubAppFragmentConfig = {
  appId: process.env.GITHUB_APP_ID ?? "",
  appSlug: process.env.GITHUB_APP_SLUG ?? "",
  privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
};

const fragment = createGitHubAppFragment(config, {
  databaseAdapter: new InMemoryAdapter(),
  outbox: { enabled: true },
});

// Public service access to the GitHub API client
const githubApiClient = fragment.services.githubApiClient;

export const { GET, POST } = fragment.handlersFor("next-js");
```

## Routes

- `POST /webhooks`
- `GET /installations`
- `GET /installations/:installationId/repos`
- `GET /repositories/linked`
- `POST /repositories/link`
- `POST /repositories/unlink`
- `GET /repositories/:owner/:repo/pulls`
- `POST /repositories/:owner/:repo/pulls/:number/reviews`
- `POST /installations/:installationId/sync`

## Client Usage

```ts
import { createGitHubAppFragmentClients } from "@fragno-dev/github-app-fragment";

const github = createGitHubAppFragmentClients({ baseUrl: "/" });

const syncInstallation = github.useSyncInstallation();
```

## Development

```bash
pnpm exec turbo types:check --filter=@fragno-dev/github-app-fragment --output-logs=errors-only
pnpm exec turbo build --filter=@fragno-dev/github-app-fragment --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-dev/github-app-fragment --output-logs=errors-only
```
