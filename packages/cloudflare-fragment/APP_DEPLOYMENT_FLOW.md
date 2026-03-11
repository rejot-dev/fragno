# Cloudflare Fragment App Creation and Deployment Flow

This document describes the current deployment model in `@fragno-dev/cloudflare-fragment`, with an
emphasis on:

- public HTTP routes
- writes to the fragment database
- outgoing Cloudflare API calls
- idempotency and concurrency behavior

## Key Point

There is no separate public "create app" route.

An app is created implicitly by the first:

```http
POST /apps/:appId/deployments
```

If the `app` row already exists, the same route queues another deployment for that app.

There is an internal `upsertApp(appId)` service, but the normal public flow is deployment-first.

## Public HTTP Surface

Write path:

- `POST /apps/:appId/deployments`

Read-only paths:

- `GET /apps`
- `GET /apps/:appId`
- `GET /apps/:appId/deployments`
- `GET /deployments/:deploymentId`

Only `POST /apps/:appId/deployments` writes fragment state directly.

`GET /apps/:appId` returns richer local state than `GET /apps`:

- `latestDeployment`: the newest deployment row in the fragment database
- `liveDeployment`: the deployment whose id matches `app.liveDeploymentId`
- `liveDeploymentError`: currently always `null` and kept for response compatibility
- `deployments`: the full local deployment history for the app, newest first

No read route currently calls Cloudflare.

## Fragment Tables

The fragment owns two tables.

- `app`
  - `id`
  - `scriptName`
  - `liveDeploymentId`
  - `liveCloudflareEtag`
  - `firstDeploymentLeaseId`
  - `createdAt`
  - `updatedAt`
- `deployment`
  - `id`
  - `appId`
  - `status`
  - `format`
  - `entrypoint`
  - `scriptName`
  - `sourceCode`
  - `sourceByteLength`
  - `compatibilityDate`
  - `compatibilityFlags`
  - `attemptCount`
  - `startedAt`
  - `completedAt`
  - `errorCode`
  - `errorMessage`
  - `cloudflareEtag`
  - `cloudflareModifiedOn`
  - `cloudflareResponse`
  - `createdAt`
  - `updatedAt`

The `uow.triggerHook("deployWorker", ...)` call also writes to Fragno's internal durable hook
storage, but those tables are owned by `@fragno-dev/db`, not by this fragment schema.

## Flow 1: First Deployment For A New App

### 1. Client request

The caller sends:

```http
POST /apps/:appId/deployments
```

with a body containing:

- `script.type`
- `script.entrypoint`
- `script.content`
- optional `compatibilityDate`
- optional `compatibilityFlags`

### 2. Route validation

The route rejects:

- non-`esmodule` script types
- empty `entrypoint`
- empty `content`

If validation passes, the route calls `services.queueDeployment(appId, payload)` inside one
`handlerTx(...)`.

### 3. Service reads

`queueDeployment(appId, request)` reads the existing `app` row by primary index.

It does not read the latest deployment row and it does not compute a `baseDeploymentId`.

### 4. Service writes

If the app does not exist yet, the service writes:

- `app`
  - `id = appId`
  - `scriptName = resolveCloudflareScriptName(appId, config)`
  - `liveDeploymentId = null`
  - `liveCloudflareEtag = null`
  - `firstDeploymentLeaseId = null`
  - `createdAt = now`
  - `updatedAt = now`

Then it writes a new `deployment` row:

- `appId = appId`
- `status = "queued"`
- `format = "esmodule"`
- `entrypoint = request.script.entrypoint`
- `scriptName = app.scriptName`
- `sourceCode = request.script.content`
- `sourceByteLength = byte length of sourceCode`
- `compatibilityDate = request.compatibilityDate ?? config.compatibilityDate`
- `compatibilityFlags = request.compatibilityFlags ?? config.compatibilityFlags ?? []`
- `attemptCount = 0`
- `startedAt = null`
- `completedAt = null`
- `errorCode = null`
- `errorMessage = null`
- `cloudflareEtag = null`
- `cloudflareModifiedOn = null`
- `cloudflareResponse = null`
- `createdAt = now`
- `updatedAt = now`

Finally it queues the durable hook:

- `triggerHook("deployWorker", hookInput)`

The hook input contains the immutable deployment snapshot plus the live etag snapshot:

- `deploymentId`
- `appId`
- `expectedLiveEtag` (`null` on the first deploy)
- `scriptName`
- `entrypoint`
- `moduleContent`
- `compatibilityDate`
- `compatibilityFlags`

### 5. HTTP response

The route returns the new deployment summary immediately.

At this point:

- the app exists locally
- the deployment exists locally with `status = "queued"`
- no Cloudflare API call has happened yet

## Flow 2: Redeploy An Existing App

The same `POST /apps/:appId/deployments` route is used.

The difference is:

- no new `app` row is inserted
- `app.updatedAt` is updated to `now`
- a new `deployment` row is inserted
- `expectedLiveEtag` is set to `app.liveCloudflareEtag` at queue time

This means the hook bases concurrency on the app's last known live provider etag, not on the latest
local deployment row.

## Flow 3: Durable Hook Execution

The durable hooks dispatcher eventually runs:

```ts
deployWorker(hookInput);
```

This is where Cloudflare is contacted.

### 1. Build the local live pointer guard

The hook derives one of two guards from the queued deployment snapshot:

- if `expectedLiveEtag !== null`, use Cloudflare compare-and-swap mode
- otherwise, treat this as a first deploy and use a local first-deploy lease

### 2. First-deploy preparation

This step only runs when `expectedLiveEtag === null`.

The hook does a local transaction that reads the queued deployment joined to its app and then:

- if the app already has `liveCloudflareEtag`, treats this deployment as already superseded without
  calling Cloudflare
- if another deployment already holds `app.firstDeploymentLeaseId`, aborts so the durable hook can
  retry later
- otherwise claims `app.firstDeploymentLeaseId = deploymentId`

This is the local guard for the "no live etag exists yet" case.

### 3. Outgoing Cloudflare API call: upload script

The default path is to attempt the upload directly:

```http
PUT /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}
```

The multipart payload contains:

- the module file for `entrypoint`
- metadata:
  - `main_module`
  - `compatibility_date`
  - `compatibility_flags`
  - `tags`

The `tags` list includes:

- any static `scriptTags` from fragment config
- the deterministic app tag for this app
- the deterministic deployment tag for this deployment

If `expectedLiveEtag !== null`, the request also includes:

```http
If-Match: <expectedLiveEtag>
```

So normal redeploys rely on Cloudflare CAS instead of a pre-upload tag read.

### 4. Reconciliation on `412 Precondition Failed`

If the upload returns `412`, the hook performs remote reconciliation by reading:

```http
GET /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/tags
GET /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}
```

Those two remote reads are issued in parallel.

The hook then classifies the result as:

- `already-deployed`
  - the current remote deployment tag already points at this deployment
- `superseded`
  - the current remote deployment tag points at another deployment
- provider error
  - if Cloudflare does not report a current deployment tag that explains the `412`

This is the only place where the current write path reads Cloudflare deployment tags.

### 5. Single local finalize transaction

After the remote work completes, the hook does one local `handlerTx()`.

Reads:

- the current `deployment` row by `deploymentId`, joined to `app`
- optionally the locally known winner deployment row if the remote result references a different
  deployment id

Writes:

- update the current deployment row
- update `app.updatedAt`
- clear `app.firstDeploymentLeaseId` if this deployment still owns it

Outcome-specific writes:

#### Already deployed remotely

- `deployment.status = "succeeded"`
- `deployment.startedAt = startedAt ?? now`
- `deployment.completedAt = completedAt ?? now`
- `deployment.attemptCount = max(attemptCount, 1)`
- clear `errorCode` and `errorMessage`
- update `app.liveDeploymentId = deploymentId`
- update `app.liveCloudflareEtag = current remote etag if known`

#### Uploaded successfully

- `deployment.status = "succeeded"`
- `deployment.startedAt = startedAt ?? now`
- `deployment.completedAt = now`
- `deployment.attemptCount = attemptCount + 1`
- clear `errorCode` and `errorMessage`
- persist provider metadata:
  - `cloudflareEtag`
  - `cloudflareModifiedOn`
  - `cloudflareResponse`

The app live pointer is only advanced when the guard still says this deployment is allowed to become
live:

- CAS mode: `app.liveCloudflareEtag` still matches `expectedLiveEtag`
- first-deploy mode: no live etag exists yet and the first-deploy lease is still owned by this
  deployment

#### Superseded by another deployment

- if the winning deployment exists locally, ensure it is marked `succeeded` and backfill its
  provider metadata when available
- update `app.liveDeploymentId` to the winning deployment id when known
- update `app.liveCloudflareEtag` to the winner etag when known
- mark the losing deployment as:
  - `status = "failed"`
  - `errorCode = "DEPLOYMENT_SUPERSEDED"`
  - `errorMessage = "Deployment was superseded by '...'."

#### Cloudflare call failed

- `deployment.status = "failed"`
- `deployment.startedAt = startedAt ?? now`
- `deployment.completedAt = now`
- `deployment.attemptCount = attemptCount + (remote upload attempted ? 1 : 0)`
- `deployment.errorCode = formatted provider error code`
- `deployment.errorMessage = formatted provider error message`
- leave the existing app live pointer unchanged

## Idempotency And Concurrency Model

The durable hook is at-least-once and may be retried.

Current convergence rules:

- normal redeploys use `If-Match` against the queued `expectedLiveEtag`
- first deploys use a local `firstDeploymentLeaseId` because no provider etag exists yet
- a retried hook for an already-applied deployment converges to local `succeeded`
- a losing concurrent deployment converges to local `failed` with `DEPLOYMENT_SUPERSEDED`

The system no longer uses `baseDeploymentId` or "latest local row wins" semantics.

## Read Paths And Write Behavior

These routes are read-only:

- `GET /apps`
  - reads all `app` rows
  - reads all `deployment` rows
  - computes latest deployment per app in memory
  - returns only `latestDeployment` per app
  - no writes
  - no Cloudflare calls
- `GET /apps/:appId`
  - reads one app summary through `getAppState(appId)`
  - reads full deployment history through `listAppDeployments(appId)`
  - derives `liveDeployment` locally by matching `app.liveDeploymentId` against the deployment list
  - returns `liveDeploymentError = null`
  - no writes
  - no Cloudflare calls
- `GET /apps/:appId/deployments`
  - reads one `app`
  - reads deployment history by `idx_deployment_app_createdAt`
  - no writes
  - no Cloudflare calls
- `GET /deployments/:deploymentId`
  - reads one `deployment` joined to `app`
  - no writes
  - no Cloudflare calls

## Practical Summary

For the public API, "create app" really means:

1. Call `POST /apps/:appId/deployments`.
2. The fragment creates the `app` row if it does not exist.
3. The fragment inserts a `deployment` row with `status = "queued"`.
4. The fragment snapshots `expectedLiveEtag` from the app's local live pointer.
5. The fragment queues `deployWorker`.
6. The durable hook attempts the Cloudflare upload directly, using `If-Match` when possible.
7. Only a `412` response triggers remote tag and script-state reads.
8. The hook finalizes local deployment state and the app live pointer.

That is the only normal write path for app creation and deployment today.
