# @fragno-dev/cloudflare-fragment

Fragno fragment for queueing and tracking Cloudflare Workers for Platforms deployments against an
existing dispatch namespace.

## Scope

- Queues a single ES module deployment for an app-facing ID
- Persists app and deployment state in the fragment database
- Reconciles remote deployments by tagging the live Worker with `<deploymentTagPrefix>-app-<appId>`
  and `<deploymentTagPrefix>-dep-<deploymentId>`
- Runs the Cloudflare upload through a durable hook after the request transaction commits
- Builds the official `cloudflare` SDK client and exposes it through
  `fragment.services.cloudflare.getClient()`
- Exposes typed routes and client hooks for queueing and status reads

## Server Setup

```ts
import { createCloudflareFragment } from "@fragno-dev/cloudflare-fragment";

const fragment = createCloudflareFragment(
  {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    dispatcher: {
      binding: env.DISPATCHER,
      namespace: "my-dispatch-namespace",
    },
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    deploymentTagPrefix: "fragno",
    scriptNamePrefix: "fragno",
    scriptNameSuffix: "worker",
  },
  {
    databaseAdapter,
  },
);
```

Outside Cloudflare Workers, you can still pass `dispatchNamespace: "my-dispatch-namespace"` if you
do not have a bound dispatch namespace object available.

The fragment computes a deterministic `scriptName` from the app-facing ID and stores it in the `app`
table the first time that app is deployed.

If you already construct your own Cloudflare SDK client, pass it as `cloudflare` in fragment config
instead of `apiToken`.

For the detailed write path, see [APP_DEPLOYMENT_FLOW.md](./APP_DEPLOYMENT_FLOW.md).

## Routes

- `GET /apps` lists known workers and their latest deployment
- `POST /apps/:appId/deployments` queues a deployment request
- `GET /apps/:appId` returns the app summary plus the latest deployment
- `GET /apps/:appId/deployments` returns the deployment history for one app
- `GET /deployments/:deploymentId` returns a single deployment status record

Queued deployments stay `queued` until durable hooks are processed.

## Durable Hooks

This fragment will not upload to Cloudflare unless the host runtime runs a durable hooks processor.
Use the Fragno DB dispatchers in Node or Cloudflare and include this fragment in the processor.

The hook payload carries the immutable deployment snapshot so the hook can reconcile remote state
before a single local finalize transaction. If the deployment tag is already live in Cloudflare, the
hook marks the deployment `succeeded` locally without re-uploading. The configured prefix is capped
per tag so `<prefix>-app-...` and `<prefix>-dep-...` stay within Cloudflare's 63 character limit.

## Client Builders

`createCloudflareFragmentClients()` exposes:

- `useApps`
- `useApp`
- `useAppDeployments`
- `useDeployment`
- `useQueueDeployment`

Framework entrypoints are available at `@fragno-dev/cloudflare-fragment/react`, `./vue`, `./svelte`,
`./solid`, and `./vanilla`.

## Development

```bash
pnpm exec turbo types:check --filter=./packages/cloudflare-fragment --output-logs=errors-only
pnpm exec turbo test --filter=./packages/cloudflare-fragment --output-logs=errors-only
pnpm exec turbo build --filter=./packages/cloudflare-fragment --output-logs=errors-only
```
