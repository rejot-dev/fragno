# GitHub App Global Webhook Routing + Organization Mapping — Spec

## 0. Open Questions

None.

## 1. Overview

The current docs backoffice GitHub integration expects an org-scoped webhook URL:

- `/api/github/:orgId/webhooks`

This is incompatible with GitHub App behavior because one GitHub App has one configured webhook
endpoint. This spec introduces a global webhook ingress that receives all deliveries, resolves
`installation_id -> orgId`, and forwards each event to the correct organization-scoped GitHub
fragment Durable Object.

The scope includes:

1. A singleton ingress/router for webhook verification + routing.
2. A durable mapping between GitHub installation IDs and backoffice organizations.
3. A secure connect flow (`state` token + setup callback) to establish mapping.
4. Backoffice UI updates to stop instructing org-specific webhook URLs.
5. Replay handling for webhooks received before mapping is established.

## 2. References

- Current org-scoped webhook forwarding: `apps/docs/app/routes/api/github.ts`
- Current org GitHub DO and admin config: `apps/docs/workers/github.do.ts`
- Current backoffice GitHub configuration UI:
  `apps/docs/app/routes/backoffice/connections/github/configuration.tsx`
- Current GitHub fragment webhook route contract: `packages/github-app-fragment/src/routes.ts`
- Current GitHub fragment webhook processing hook:
  `packages/github-app-fragment/src/github/webhook-processing.ts`
- External references: `specs/references/github-app-webhook-routing.md`

## 3. Terminology

- **Ingress DO**: Singleton Durable Object that handles GitHub webhook ingress, verification, and
  routing.
- **Org GitHub DO**: Existing per-org Durable Object hosting the GitHub fragment.
- **Installation Binding**: Durable mapping record from GitHub `installation_id` to Fragno `orgId`.
- **Connect Session**: One-time, expiring state token used during GitHub App install/setup flow.
- **Unclaimed Delivery**: A verified webhook delivery for an installation not yet bound to an org.

## 4. Goals / Non-goals

### 4.1 Goals

1. Support a single webhook URL per environment (global ingress endpoint).
2. Route webhook deliveries to the correct organization based on `installation_id`.
3. Provide deterministic, auditable binding from installation to organization.
4. Secure the connect/setup flow against replay and cross-org takeover.
5. Preserve existing org-scoped GitHub fragment behavior once routing resolves org.
6. Improve operational visibility of claimed/unclaimed deliveries in backoffice.

### 4.2 Non-goals

1. Multi-app orchestration (one environment hosting multiple GitHub Apps).
2. Replacing the GitHub fragment’s webhook verification/business logic.
3. Solving org ownership semantics beyond current backoffice auth/member checks.
4. Cross-environment installation migration tooling.

## 5. Architectural Changes

### 5.1 Global ingress path

Add a new global API route:

- `POST /api/github/webhooks`

This route forwards to a singleton ingress DO:

- `env.GITHUB_INGRESS.get(env.GITHUB_INGRESS.idFromName("GLOBAL"))`

### 5.2 Ingress responsibilities

Ingress DO is responsible for:

1. Validating signature (`x-hub-signature-256`) using `GITHUB_APP_WEBHOOK_SECRET`.
2. Validating required delivery metadata (`x-github-delivery`, `x-github-event`).
3. Extracting `installation_id`.
4. Deduplicating by delivery ID.
5. Looking up installation binding.
6. Forwarding to org GitHub DO when binding exists.
7. Persisting delivery as unclaimed when binding does not exist.
8. Replaying unclaimed deliveries after binding creation.

### 5.3 Org DO responsibilities

Org GitHub DO remains responsible for:

1. Running `@fragno-dev/github-app-fragment`.
2. Handling org-scoped backoffice operations (sync, link/unlink, pull listing).
3. Handling webhook business processing exactly as today once events are routed.

## 6. Data Model (Ingress)

Ingress DO stores mapping + connect/session state + unclaimed deliveries in Durable Object SQLite.

### 6.1 `installation_binding`

- `installationId TEXT PRIMARY KEY`
- `orgId TEXT NOT NULL`
- `status TEXT NOT NULL` (`active | suspended | deleted`)
- `boundByUserId TEXT NULL`
- `boundAt TEXT NOT NULL`
- `updatedAt TEXT NOT NULL`

Indexes:

- `idx_binding_org_id` on `orgId`

### 6.2 `connect_session`

- `stateHash TEXT PRIMARY KEY`
- `stateId TEXT NOT NULL` (opaque id for diagnostics)
- `orgId TEXT NOT NULL`
- `userId TEXT NOT NULL`
- `createdAt TEXT NOT NULL`
- `expiresAt TEXT NOT NULL`
- `usedAt TEXT NULL`
- `installationId TEXT NULL` (set on completion)

Indexes:

- `idx_connect_org_id` on `orgId`
- `idx_connect_expires_at` on `expiresAt`

### 6.3 `webhook_delivery`

- `deliveryId TEXT PRIMARY KEY`
- `installationId TEXT NOT NULL`
- `event TEXT NOT NULL`
- `action TEXT NULL`
- `payloadJson TEXT NOT NULL`
- `headersJson TEXT NOT NULL`
- `receivedAt TEXT NOT NULL`
- `orgId TEXT NULL` (resolved org when forwarded/replayed)
- `forwardStatus TEXT NOT NULL` (`unclaimed | forwarded | replayed | failed`)
- `forwardError TEXT NULL`

Indexes:

- `idx_delivery_installation_id` on `installationId`
- `idx_delivery_status` on `forwardStatus`

Retention:

- Keep delivery rows for 7 days for observability and replay safety.
- Cleanup via ingress DO alarm or opportunistic cleanup on write.

## 7. Connect + Binding Flow

### 7.1 Start connect session

Backoffice configuration page requests a connect session for an org.

Ingress creates:

1. Random high-entropy state token.
2. Hash (`sha256`) stored as `stateHash`.
3. Session row with short TTL (default 15 minutes).

Ingress returns:

- `installUrl = https://github.com/apps/:slug/installations/new?state=<token>`
- `expiresAt`

### 7.2 Setup callback

Add callback route:

- `GET /api/github/setup/callback`

Callback requirements:

1. User must be authenticated in backoffice.
2. `state` must exist, be unexpired, and unused.
3. Authenticated user must still belong to the target org.
4. `installation_id` must be present.

On success:

1. Mark connect session as used.
2. Upsert installation binding.
3. Trigger replay of unclaimed deliveries for that installation.
4. Redirect user back to org GitHub configuration page with success flag.

### 7.3 Binding conflict policy

If an installation is already bound to a different org:

1. Reject automatic bind by default.
2. Return explicit error code (`INSTALLATION_ALREADY_BOUND`).
3. Surface conflict in UI with currently bound org (if visible to actor) or redacted message.

Future transfer flow is out of scope.

## 8. Webhook Routing + Replay

### 8.1 Ingress processing sequence

For each `POST /api/github/webhooks`:

1. Validate signature and payload shape.
2. Parse `installation_id`.
3. Deduplicate `deliveryId` (idempotent no-op if seen).
4. Lookup binding:
   - **bound**: forward immediately to org GitHub DO.
   - **unbound**: persist as `unclaimed` and return `202`.

### 8.2 Forwarding contract

Ingress forwards original body + GitHub headers to org GitHub DO endpoint:

- Internal forwarded request path: `/api/github/webhooks`

Forwarding always preserves:

1. `x-hub-signature-256`
2. `x-github-delivery`
3. `x-github-event`
4. Raw request body bytes

This keeps org DO + fragment behavior compatible and avoids fragment-level contract changes.

### 8.3 Replay

When a binding is created:

1. Select unclaimed deliveries for `installationId`, ordered by `receivedAt`.
2. Forward sequentially (or bounded concurrency = 1 by default).
3. Mark status `replayed` or `failed` with error.

Replay must be idempotent by delivery ID.

## 9. Backoffice UI Changes

### 9.1 Configuration page updates

Replace org-scoped webhook guidance:

- from `.../api/github/:orgId/webhooks`
- to `.../api/github/webhooks`

Add explicit connect action:

1. “Connect GitHub App” button starts connect session and redirects to install URL.
2. Callback success/failure banners.
3. Installation binding status panel.

### 9.2 Installations view semantics

Current per-org installation list remains, but is now filtered by binding:

1. Only installations bound to current org are shown in org configuration/repositories screens.
2. Unclaimed installations are shown in ingress-level diagnostics (optional admin view).

### 9.3 Disabled-state messaging

If app env config is missing:

1. Keep tabs disabled as implemented.
2. Show ingress-specific requirement text emphasizing `GITHUB_APP_PRIVATE_KEY` secret usage.

## 10. API / RPC Additions

### 10.1 Ingress DO RPC methods

Add methods callable from loaders/actions:

1. `createConnectSession(orgId: string, userId: string): Promise<{ installUrl: string; expiresAt: string }>`
2. `completeConnectSession(input): Promise<{ orgId: string; installationId: string; replayed: number }>`
3. `getBindingStatus(orgId: string): Promise<{ bindings: BindingSummary[] }>`
4. `claimInstallation(input): Promise<{ ok: true }>` (manual fallback)
5. `getUnclaimedForOrgCandidates(...)` (optional admin tooling; exact API may be refined)

### 10.2 New routes

1. `POST /api/github/webhooks` → ingress forwarding route
2. `GET /api/github/setup/callback` → setup callback route

Existing org-scoped route remains:

1. `/api/github/:orgId/*` for org GitHub fragment operations

## 11. Security / Authorization

1. Signature verification happens at ingress for every webhook.
2. Connect state token:
   - high entropy random,
   - hashed at rest,
   - strict TTL,
   - single use.
3. Callback requires authenticated user + org membership validation.
4. Binding changes require org admin/owner role (enforced via backoffice auth context).
5. Do not expose private webhook payload details to unauthorized users.

## 12. Operational Concerns

1. Deduplication by `deliveryId` prevents repeated side effects.
2. Replay queue handles mapping race where webhook arrives before callback completes.
3. Delivery logs enable diagnostics for missed or failed forwarding.
4. Cleanup policy prevents unbounded storage growth.
5. Metrics/log counters:
   - `webhook_received_total`
   - `webhook_forwarded_total`
   - `webhook_unclaimed_total`
   - `webhook_replay_failed_total`
   - `connect_session_created_total`
   - `binding_conflict_total`

## 13. Testing & Verification

1. Unit tests:
   - state token lifecycle (create/use/expire/replay protection)
   - binding upsert + conflict semantics
   - delivery dedupe behavior
2. Integration tests:
   - unbound webhook -> unclaimed persistence
   - bind -> replay -> org DO processing
   - callback auth/org validation paths
3. Backoffice route tests:
   - configuration shows global webhook URL
   - connect action/callback messaging
4. Regression tests:
   - existing org GitHub operations still work (sync/link/pulls)

## 14. Decisions (Locked)

1. Global webhook endpoint is mandatory for GitHub App integration.
2. Installation routing key is `installation_id`, not org path/slug/account login.
3. `GITHUB_APP_PRIVATE_KEY_FILE` is not supported in Workers runtime; `GITHUB_APP_PRIVATE_KEY`
   secret is required.
4. Automatic binding uses setup callback with one-time state token.
5. Unclaimed deliveries are persisted and replayed after binding.

## 15. FP Plan (Issue Hierarchy)

Parent issue:

- `FRAGNO-nwmnxuhi` — GitHub App global webhook ingress + installation-to-org routing

Child issues:

1. `FRAGNO-twonpuwv` — Add GitHub ingress DO, storage schema, and global webhook route. Spec
   sections: 5.1, 5.2, 6, 8.1, 10.2
2. `FRAGNO-ucctxsjx` — Implement connect session and setup callback binding flow. Depends on:
   `FRAGNO-twonpuwv` Spec sections: 7, 10.1, 10.2, 11
3. `FRAGNO-pyvrnymq` — Add installation binding conflict policy and org-scope binding APIs. Depends
   on: `FRAGNO-twonpuwv`, `FRAGNO-ucctxsjx` Spec sections: 6.1, 7.3, 9.2, 10.1, 14
4. `FRAGNO-vfujxstd` — Implement unclaimed webhook persistence and replay pipeline. Depends on:
   `FRAGNO-twonpuwv`, `FRAGNO-pyvrnymq` Spec sections: 6.3, 8.2, 8.3, 12, 14
5. `FRAGNO-qitkxpdv` — Update backoffice GitHub UX for global webhook + connect flow. Depends on:
   `FRAGNO-ucctxsjx`, `FRAGNO-pyvrnymq` Spec sections: 9, 10, 11
6. `FRAGNO-juzjwkav` — Add tests, observability, and docs for ingress routing. Depends on:
   `FRAGNO-vfujxstd`, `FRAGNO-qitkxpdv` Spec sections: 12, 13, 14
