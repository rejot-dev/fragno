# GitHub App Installation Flow (Current Implementation)

This describes the current GitHub installation flow in `apps/backoffice`, including UI behavior,
global callback/webhook routes, and Durable Object responsibilities.

## Required GitHub App Settings

These URLs are global (not org-specific):

1. Setup URL

- `https://<origin>/backoffice/connections/github/setup-callback`

2. Webhook URL

- `https://<origin>/api/github/webhooks`

## Runtime Components

1. User-facing org configuration page

- Route: `/backoffice/connections/github/:orgId/configuration`
- File: `apps/backoffice/app/routes/backoffice/connections/github/configuration.tsx`
- Role:
  - Starts installation for a specific org
  - Consumes callback query params (`state`, `installation_id`, `setup_action`)
  - Maps `installation_id -> orgId` in the router singleton DO
  - Shows installation/repository linking UI once local installation state exists

2. Global setup callback route

- Route: `/backoffice/connections/github/setup-callback`
- File: `apps/backoffice/app/routes/backoffice/connections/github/setup-callback.tsx`
- Role:
  - Requires signed-in user
  - Resolves org from nonce `state` via router singleton DO
  - Redirects to `/backoffice/connections/github/:orgId/configuration` with original query params

3. Global webhook ingress route

- Route: `/api/github/webhooks`
- File: `apps/backoffice/app/routes/api/github-webhooks.ts`
- Role:
  - Extracts `installation_id` from webhook payload
  - Resolves `installation_id -> orgId` via router singleton DO
  - Forwards mapped webhooks to org GitHub DO
  - Queues unmapped webhooks for replay

4. Org-scoped GitHub API proxy route

- Route: `/api/github/:orgId/*`
- File: `apps/backoffice/app/routes/api/github.ts`
- Role:
  - Proxies org-scoped API requests into the org GitHub DO (`/api/github/*`)

5. Operator internals page

- Route: `/backoffice/internals/github`
- File: `apps/backoffice/app/routes/backoffice/internals/github.tsx`
- Role:
  - Shows runtime config health
  - Shows router singleton snapshot (installation mappings, pending webhook queue, active install
    states)
  - Shows canonical Setup URL and Webhook URL to configure in GitHub App settings

## Durable Object Model

There are two GitHub Durable Object classes:

1. Org GitHub fragment DO

- Binding/class: `GITHUB` / `GitHub`
- File: `apps/backoffice/workers/github.do.ts`
- Keyed by: `orgId`
- Responsibilities:
  - Hosts GitHub fragment runtime
  - Runs DB migrations
  - Handles fragment routes (`/api/github/*`), including `/api/github/webhooks`
  - Runs durable-hook dispatcher alarm processing
  - On uninstall callback, requests routing cleanup in singleton DO

2. Global router singleton DO

- Binding/class: `GITHUB_WEBHOOK_ROUTER` / `GitHubWebhookRouter`
- File: `apps/backoffice/workers/github-webhook-router.do.ts`
- Keyed by singleton name: `GITHUB_WEBHOOK_ROUTER_SINGLETON_ID`
- Responsibilities:
  - Stores nonce install state records
  - Stores `installation_id -> orgId` mapping
  - Stores and replays pending global webhooks
  - Exposes admin config and snapshot for internals UI

## Router Singleton Storage Keys

1. Install nonce state

- Prefix: `github-install-state:`
- Value: `{ userId, orgId, createdAt, expiresAt }`
- TTL: 10 minutes

2. Installation mapping

- Prefix: `github-installation-org:`
- Value: `orgId`

3. Pending global webhook queue

- Prefix: `github-pending-webhook:`
- Value: `{ method, headers, body, receivedAt }`

## End-to-End Install Flow

### A) Precondition: runtime configuration

The flow only works when `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET`, and
`GITHUB_APP_PRIVATE_KEY` are configured. In Workers runtime, `GITHUB_APP_PRIVATE_KEY_FILE` is not
supported.

If not configured, org configuration page shows:

- "GitHub linking not available"
- Link to `/backoffice/internals/github` for operator troubleshooting

### B) Start installation from org page

1. User opens:

- `/backoffice/connections/github/:orgId/configuration`

2. User clicks **Start installation** (`intent=start-installation`).

3. Route calls router singleton DO:

- `createInstallStatefulUrl(userId, orgId)`

4. Router DO creates nonce state (`crypto.getRandomValues` + base64url) and returns:

- `https://github.com/apps/<slug>/installations/new?state=<nonce>`

5. Browser redirects to GitHub install UI.

### C) GitHub Setup URL callback (global route)

1. GitHub redirects to:

- `/backoffice/connections/github/setup-callback?state=...&installation_id=...&setup_action=...`

2. Setup callback route:

- requires signed-in user
- resolves state via `resolveInstallState({ state, userId })`
- redirects to org page:
  - `/backoffice/connections/github/:orgId/configuration?...`

### D) Callback handling on org configuration route

When callback params are present, loader does:

1. Handles approval-only callbacks:

- if `setup_action=request`, redirects with `installFlow=install_requested`

2. Validates callback fields (`state`, numeric `installation_id`).

3. Consumes state via router DO:

- `consumeInstallState({ state, userId, installationId })`
- enforces: exists, not expired, same user
- single-use: state key is deleted

4. Validates callback org context matches current `:orgId`.

5. Stores mapping via router DO:

- `setInstallationOrg(installationId, orgId)`
- triggers immediate replay attempt of queued webhooks for that installation
- conflict-safe: existing mapping to a different org is rejected (`INSTALLATION_ORG_CONFLICT`)
  instead of being overwritten

6. Redirects to clean URL with install notice:

- `installFlow=installed_pending_webhook`

Important:

- The docs app currently does **not** call `/installations/:installationId/sync` during callback
  handling.
- Local installation rows are expected to arrive through webhook processing.

### E) Global webhook ingress and routing

1. GitHub sends webhook to `/api/github/webhooks`.

2. Route verifies runtime webhook secret is configured.

3. Route verifies `x-hub-signature-256` against raw payload using `GITHUB_APP_WEBHOOK_SECRET`.

- Invalid/missing signature is rejected with `401` (`WEBHOOK_SIGNATURE_INVALID`).
- No pending webhook is stored for failed signature checks.

4. Route extracts `installation_id` from payload.

5. Route asks router DO for mapping:

- `getInstallationOrg(installationId)`

6. If mapped:

- forwards to org DO endpoint `/api/github/webhooks?orgId=<orgId>`

7. If unmapped:

- router DO stores pending envelope (`enqueuePendingWebhook`)
- route responds `202` with code `INSTALLATION_ORG_MAPPING_NOT_FOUND`

### F) Fragment webhook handling and durable hooks

Inside the org `GitHub` DO:

1. `/api/github/webhooks` verifies signature and basic payload shape.

2. It enqueues hook work (`processWebhook`) via durable-hooks, then returns `204`.

3. Actual DB mutations (installation/repos/link cleanup logic) run asynchronously in durable-hook
   processing.

4. Supported webhook events for state mutation:

- `installation`
- `installation_repositories`

This means `204` from webhook route indicates accepted/enqueued, not necessarily that installation
rows are already visible.

### G) UI state after installation

- If no active local installation row yet, configuration page shows:
  - "GitHub callback validated, but the installation is not in local state yet. Wait for webhook
    delivery and refresh this page."
- Once local active installation exists, the install card switches from **Start installation** to
  **View installation on GitHub**.

## Uninstall Flow

1. GitHub sends `installation` webhook with `action=deleted`.

2. Fragment webhook processor handles uninstall and calls configured
   `webhook((register) => register("installation.deleted", handler))`.

3. Org `GitHub` DO webhook handler callback calls router singleton:

- `clearInstallationRouting(installationId)`

4. Router singleton cleanup removes:

- `installation_id -> orgId` mapping
- pending queued webhooks for that installation

## Debugging and Operational Checks

1. Router singleton state (global)

- Open `/backoffice/internals/github`
- Check:
  - Installation mappings
  - Pending webhook queue
  - Active install states

2. Org durable-hook queue (async processor state)

- Open `/backoffice/internals/durable-hooks/:orgId/github`
- Check failed/retrying `processWebhook` hook entries

3. Callback success but no local installation yet

- Common reasons:
  - webhook not delivered to endpoint
  - webhook queued before mapping and replay has not succeeded yet
  - webhook processing failed in durable-hook execution (even if ingress returned 2xx/204)
  - callback attempted to map an installation that is already linked to a different org
    (`INSTALLATION_ORG_CONFLICT`)
  - duplicate/near-simultaneous webhook processing can fail with DB unique-constraint errors (for
    example `installation_repo.id`), leaving installation state partially applied until another
    successful webhook updates state

## Current Endpoint Summary

1. Setup callback (global)

- `/backoffice/connections/github/setup-callback`

2. Org configuration (user-facing)

- `/backoffice/connections/github/:orgId/configuration`

3. Webhook ingress (global)

- `/api/github/webhooks`

4. Org-scoped GitHub API proxy

- `/api/github/:orgId/*`

5. Operator internals page

- `/backoffice/internals/github`

6. Org durable-hook queue page

- `/backoffice/internals/durable-hooks/:orgId/github`
