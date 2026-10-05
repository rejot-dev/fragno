# @fragno-dev/project-connector-fragment

A DB-backed Fragno fragment for the hosted OOMOL **Project Connector** API. It connects product
users to Gmail and other configured OAuth providers, verifies account bindings, reads provider
profiles, and executes actions using an explicit connected account.

This package uses `oo_proj_...` project keys. It does not use personal `api_...` keys or the
separate self-hosted SDK surface. Create a project and provider configuration in OOMOL Console
first; see the [Project Connector guide](https://oomol.com/docs/project-connector/).

## Try the CLI

From the repository root, using the same Node version used to install `better-sqlite3`:

```bash
pnpm --filter @fragno-dev/project-connector-fragment cli -- check \
  --env-file ../../apps/backoffice/.dev.vars

pnpm --filter @fragno-dev/project-connector-fragment cli -- connect gmail \
  --env-file ../../apps/backoffice/.dev.vars \
  --user-id wilco --connection-name work --beep
```

The environment file is relative to the package directory for these `pnpm` commands. With the built
package, commands can also run from the repository root:

```bash
node packages/project-connector-fragment/bin/run.js check --env-file apps/backoffice/.dev.vars
```

After installation, use `fragno-project-connector` instead of the `node .../bin/run.js` prefix.

The required server environment variables are:

```dotenv
OOMOL_CONNECTOR_BASE_URL=https://connector.oomol.com/v1
OOMOL_PROJECT_API_KEY=oo_proj_...
```

`OOMOL_CONNECTOR_BASE_URL` is the Connector API root and must end in `/v1`. Environment variables
override values in `--env-file`. The key never travels through the browser and is not stored in
SQLite or printed in diagnostics.

`connect` opens the authorization link, temporarily listens on `127.0.0.1:3930`, and polls the saved
request. On success it stores the verified binding and performs a **read-only provider profile
check**. It does not read Gmail messages or send email. `--beep` requests an audible authorization
prompt; `--no-open` only prints the link. `--provider-config-id` selects a particular provider
config instead of asking the gateway to resolve the service.

Local state defaults to `~/.fragno/project-connector-fragment`; override it with `--data-dir`. Keep
`--user-id` and `--data-dir` consistent across commands. Use `--port` for a different callback port
and `--timeout-ms` to shorten the OAuth wait (maximum ten minutes).

Additional commands:

```bash
fragno-project-connector accounts --user-id wilco --env-file ./connector.env
fragno-project-connector status <request-id> --user-id wilco --env-file ./connector.env
fragno-project-connector profile <account-id> --user-id wilco --env-file ./connector.env

# Explicit action calls may read or modify provider data. Nothing executes automatically.
fragno-project-connector execute <account-id> gmail.search_threads \
  --user-id wilco --env-file ./connector.env --input '{"query":"is:unread"}'
```

All CLI operations exercise the fragment's real HTTP handler and SQLite migrations. The callback
page is navigation feedback only: even a forged callback account ID cannot create a binding. The
local CLI chooses its own user identity; do not expose it as an application server.

A successful `check` establishes gateway reachability and project-key authentication, not Gmail
availability. The SaaS API has no health endpoint, so this check expects the authenticated
`connection_request_not_found` response for a fresh, nonexistent request ID. All provider calls go
through the official `@oomol-lab/connector` `ProjectConnector` client.

## Server integration

```ts
import { createProjectConnectorFragment } from "@fragno-dev/project-connector-fragment";

const callbackUrl = "https://app.example.com/integrations/connected";
const fragment = createProjectConnectorFragment(
  {
    baseUrl: env.OOMOL_CONNECTOR_BASE_URL,
    apiKey: env.OOMOL_PROJECT_API_KEY,
    // Implement this using your application's authenticated session, not a user-supplied ID.
    getExternalUserId: resolveAuthenticatedUserId,
    allowedReturnUrls: (url) => url.toString() === callbackUrl,
  },
  { databaseAdapter },
);
```

`getExternalUserId(headers)` returns the authenticated product user's external ID or `null`. Mount
and migrate the fragment using your application's usual Fragno integration. The default mount is
`/api/project-connector-fragment`. Restrict provider/action access with your application's
authorization policy when needed; the fragment enforces account ownership and action/service
matching.

## Provider configuration discovery

`GET /provider-configs` returns live OAuth configuration metadata for the configured project:
`projectId` and `providerConfigs`, whose entries contain `id`, `service`, `displayName`,
`callbackUrl`, `effectiveScopes`, and `proxyAvailable`, without action IDs. Use the
`useProviderConfigs` client hook to load this catalog, then pass the selected entry's `id` as
`providerConfigId` when connecting, especially when several configurations use the same service.

`GET /provider-configs/:providerConfigId/actions` and the `useProviderActions` client hook retrieve
`{ projectId, providerConfigId, actionIds }` for one exact configuration. An unknown configuration
returns `PROVIDER_CONFIG_NOT_FOUND` (404); a known configuration with no actions returns an empty
`actionIds` list. Discovery never executes actions.

Discovery requires an authenticated product user but is project-scoped, not an account list. It
neither creates connections nor verifies provider accounts, and does not include API-key or custom
credential configurations. The server calls `/v1/saas/oauth/provider-configs` with the project key;
credentials and extra upstream fields stay outside the public response. Unsupported deployments and
upstream failures return `PROJECT_CONNECTOR_ERROR`, rather than an invented or cached catalog.

## Client flow

```ts
import { createProjectConnectorFragmentClient } from "@fragno-dev/project-connector-fragment/vanilla";

const connector = createProjectConnectorFragmentClient();
const request = await connector.connect().mutate({
  body: {
    providerConfigId: "your-gmail-provider-config-id",
    connectionName: "work",
    returnUri: "https://app.example.com/integrations/connected",
  },
});

// Remember request.id before navigating. Do not trust callback query parameters.
window.location.assign(request.authorizationUrl);

// After returning, or while polling in the initiating UI:
const confirmed = await connector.refreshConnection().mutate({ path: { requestId: request.id } });
if (confirmed.state.status === "connected") {
  const profile = await fetch(
    `/api/project-connector-fragment/accounts/${confirmed.state.connectedAccountId}/profile`,
  ).then((response) => response.json());
}
```

Use exactly one of `providerConfigId` or `service` when connecting. Explicit provider IDs are
preferred for projects with multiple configurations for one service. React, Vue, Svelte, and Solid
entrypoints also export `createProjectConnectorFragmentClient` with their native adapter
conventions.

Client operations: `useProviderConfigs`, `useProviderActions`, `useStatus`, `useAccounts`,
`useProfile`, `connect`, `refreshConnection`, and `executeAction`. Refreshing a connection
invalidates the account-list store. The account list is cursor-paginated (25 items per page); it
lists local verified bindings, not live provider availability.

## Routes

| Method | Path                                          | Purpose                                                       |
| ------ | --------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/provider-configs`                           | Overview of this project's available OAuth configurations     |
| GET    | `/provider-configs/:providerConfigId/actions` | List action IDs for one exact OAuth configuration             |
| GET    | `/status`                                     | Check project-key authentication                              |
| POST   | `/connection-requests`                        | Create an OAuth authorization link and save expected identity |
| POST   | `/connection-requests/:requestId/refresh`     | Verify gateway status and bind a completed account            |
| GET    | `/accounts?cursor=...`                        | List this user's locally verified account bindings            |
| GET    | `/accounts/:accountId/profile`                | Read and verify the provider account profile                  |
| POST   | `/accounts/:accountId/actions/:actionId`      | Execute `{ "input": { ... } }` using the saved selector       |

A connection is bound only when the authenticated gateway response is `connected` and matches the
saved request ID, project, provider config, external user, service, and connection name. `failed`
and `expired` are terminal and never create account bindings. Product users cannot select a
different user ID in request bodies, read other users' bindings, or execute actions on them.

Action output stays opaque; responses preserve `executionId` and `actionId` for troubleshooting.
Requests have a 30-second timeout. Action POSTs are **not automatically retried**, since retrying a
write such as `gmail.send_email` can duplicate its side effects. Upstream errors return safe
connector codes without exposing raw response bodies. Database errors still surface as database
errors.

This first version deliberately excludes provider setup/admin APIs, credential import, account
disconnect, a personal catalog API, and background synchronization. OAuth tokens are managed by
Project Connector, not by this fragment.

## Development

```bash
pnpm exec turbo build types:check test --filter=@fragno-dev/project-connector-fragment --output-logs=errors-only
```

Scenario tests exercise a real local HTTP gateway, SQLite operations, authenticated routes, client
store invalidation, cursor pagination, and persistent CLI state. They do not use your real API key.
