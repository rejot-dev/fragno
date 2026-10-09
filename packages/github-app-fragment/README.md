# github-app-fragment

A Fragno fragment that integrates a GitHub App using installation-only authentication. Includes a
CLI to run a local server and call all fragment routes for integration testing.

## Features

- JWT + installation access token auth
- Webhook-driven installation and repository tracking
- Explicit repo linking for access control, by repository ID or by `owner/repo` name
- Pull request listing + review creation
- Short-lived read tokens and a REST proxy, both restricted to one linked repository
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
   - **Contents**: Read-only, for `POST /repositories/access-token`

   These permissions are also the upper bound for `POST /repositories/:owner/:repo/api`: the proxy
   can call any repository endpoint, but only with what the installation was granted.

4. Subscribe to webhook events:
   - `installation`
   - `installation_repositories`
5. Generate a **private key** and download the `.pem` file.
6. If your app sends users through GitHub's install page and handles the redirect (the **Setup URL**
   under _Post installation_), also enable **Redirect on update**. Without it, GitHub only redirects
   after the first install, not when a user later adds repositories to an existing installation.
7. Install the App on the repositories you want to test with.

### Generating the PEM private key

1. Open your GitHub App settings page.
2. Scroll to **Private keys**.
3. Click **Generate a private key**.
4. Download the `.pem` file and store it securely.

## Environment

```bash
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-github-app
GITHUB_APP_CLIENT_ID=Iv23yourgithubappclientid
GITHUB_APP_CLIENT_SECRET=your-github-app-client-secret
GITHUB_APP_CALLBACK_URL=https://your-app.example.com/github/oauth/callback
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
  clientId: process.env.GITHUB_APP_CLIENT_ID ?? "",
  clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? "",
  callbackUrl: process.env.GITHUB_APP_CALLBACK_URL ?? "",
  privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
  webhook: (register) => {
    register("installation.deleted", async ({ payload }) => {
      // Optional: cleanup app-specific state when an installation is removed in GitHub.
      console.log("GitHub app uninstalled", payload.installation.id);
    });
  },
  // Optional: replaces the global fetch for GitHub REST and OAuth requests, e.g. a fake GitHub API
  // in tests.
  // fetch: fakeGitHubFetch,
};

const fragment = createGitHubAppFragment(config, {
  databaseAdapter: new InMemoryAdapter(),
  outbox: { enabled: true },
});

// Public service access to both the raw App instance and helper client
const app = fragment.services.app;
const githubApiClient = fragment.services.githubApiClient;

export const { GET, POST } = fragment.handlersFor("next-js");
```

## Routes

Repository links carry a link key, so one repository can be linked for several contexts. Routes that
accept `linkKey` fall back to the configured `defaultLinkKey`, or `default`.

Webhooks and user authorization:

- `POST /webhooks`
- `POST /oauth/start`
- `POST /oauth/complete`

Installations:

- `GET /installations`
- `GET /installations/:installationId/repos`
- `POST /installations/:installationId/sync` — re-read the installation's repositories from GitHub

Repositories by ID:

- `GET /repositories/linked`
- `POST /repositories/link`
- `POST /repositories/unlink`
- `POST /repositories/access-token` — a short-lived token that can only read one linked repository's
  contents

Repositories by name:

- `GET /repositories/:owner/:repo` — whether the repository is `not-installed` (no installation on
  `owner`), `not-granted` (an installation on `owner` cannot reach it), or `reachable`, and whether
  it is linked
- `POST /repositories/:owner/:repo/link` — link a reachable repository; `REPO_NOT_REACHABLE` until
  GitHub grants the installation access
- `POST /repositories/:owner/:repo/unlink` — reports `unlinked` or `not-linked`
- `POST /repositories/:owner/:repo/api` — the REST proxy described below

Pull requests:

- `GET /repositories/:owner/:repo/pulls`
- `POST /repositories/:owner/:repo/pulls/:number/reviews`

### Repository REST proxy

`POST /repositories/:owner/:repo/api` sends one GitHub REST request on behalf of a linked
repository:

```json
{ "method": "GET", "path": "/issues", "query": { "state": "open" }, "body": null }
```

- `path` is relative to `/repos/{owner}/{repo}`; use `""` for the repository itself. Paths with `.`
  or `..` segments (including percent-encoded ones), `?`, `#`, or `\` are rejected, so a request
  cannot leave the repository.
- The request uses an installation token restricted to this one repository, with the installation's
  permissions.
- The response is `{ status, headers, body }`. GitHub's error statuses are returned as results, not
  route errors. `headers` contains only `link` and the `x-ratelimit-*` headers.
- Bodies are JSON in both directions.

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
