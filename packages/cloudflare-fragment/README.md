# @fragno-dev/cloudflare-fragment

Fragno fragment for Cloudflare platform primitives, including Workers for Platforms deployments and
Browser Run Quick Actions.

## Scope

- Queues a single ES module deployment for an app-facing ID
- Persists app and deployment state in the fragment database
- Reconciles remote deployments by tagging the live Worker with `<deploymentTagPrefix>-app-<appId>`
  and `<deploymentTagPrefix>-dep-<deploymentId>`
- Runs the Cloudflare upload through a durable hook after the request transaction commits
- Builds the official `cloudflare` SDK client and exposes it through
  `fragment.services.cloudflare.getClient()`
- Exposes Browser Run Quick Actions through `fragment.services.browserRun`
- Exposes typed routes and client hooks for queueing and status reads

## Server Setup

```ts
import { createCloudflareFragment } from "@fragno-dev/cloudflare-fragment";

const fragment = createCloudflareFragment(
  {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    workersForPlatforms: {
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
  },
  {
    databaseAdapter,
  },
);
```

Outside Cloudflare Workers, you can instead pass
`workersForPlatforms: { dispatchNamespace: "my-dispatch-namespace", ... }` if you do not have a
bound dispatch namespace object available.

`workersForPlatforms` is optional. Browser Run-only integrations only need the top-level Cloudflare
account and authentication configuration.

The fragment computes a deterministic `scriptName` from the app-facing ID and stores it in the `app`
table the first time that app is deployed.

If you already construct your own Cloudflare SDK client, pass it as `cloudflare` in fragment config
instead of `apiToken`.

For the detailed write path, see [APP_DEPLOYMENT_FLOW.md](./APP_DEPLOYMENT_FLOW.md).

## Browser Run Quick Actions

The server-side `browserRun` service calls Cloudflare's REST API using the fragment's configured
`accountId` and Cloudflare client. When using `apiToken`, the token needs the
`Browser Rendering - Edit` permission.

```ts
const html = await fragment.services.browserRun.content({
  url: "https://fragno.dev",
});

const screenshot = await fragment.services.browserRun.screenshot({
  url: "https://fragno.dev",
  screenshotOptions: {
    fullPage: true,
  },
});

const crawlJobId = await fragment.services.browserRun.startCrawl({
  url: "https://fragno.dev/docs",
  limit: 25,
});

const crawl = await fragment.services.browserRun.getCrawl(crawlJobId);
```

The MVP exposes the stateless `content`, `pdf`, `scrape`, `screenshot`, `snapshot`, `json`, `links`,
`markdown`, and `accessibilityTree` actions. Crawl jobs are exposed through `startCrawl`,
`getCrawl`, and `cancelCrawl`.

CDP clients, Puppeteer, Playwright, and Worker browser bindings remain outside this fragment's
scope. Browser session and target lifecycle operations are available through the Cloudflare REST API
service described below.

Quick Actions are split by their response and lifecycle semantics:

- `POST /browser-run/extract` returns JSON for `content`, `scrape`, `snapshot`, `json`, `links`,
  `markdown`, and `accessibility-tree`.
- `POST /browser-run/capture` returns raw PDF or image bytes for `pdf` and `screenshot`, preserving
  Cloudflare's response `Content-Type`.
- `POST /browser-run/crawl` returns JSON for the `start`, `get`, and `cancel` crawl lifecycle
  actions.

```ts
await client.useBrowserRunExtract.mutate({
  body: {
    action: "content",
    input: { url: "https://fragno.dev" },
  },
});

const screenshot = await client.captureBrowserRun({
  action: "screenshot",
  input: { url: "https://fragno.dev" },
});

await client.useBrowserRunCrawl.mutate({
  body: {
    action: "start",
    input: { url: "https://fragno.dev/docs" },
  },
});
```

Extract and crawl responses return `{ action, result }`, allowing clients to narrow the result type
from the action. Crawl `start` returns `{ jobId }` under `result`. Capture responses are raw
`Response` objects so consumers can use `blob()`, `arrayBuffer()`, or stream the body directly to a
file.

## Browser Run Sessions

The `browserRunSessions` service manages remote Browser Run sessions and their browser targets. It
returns Cloudflare's session and target metadata, including WebSocket debugger URLs when Cloudflare
provides them, but does not connect to CDP or include a browser automation library.

```ts
const session = await fragment.services.browserRunSessions.create({
  keep_alive: 600_000,
});

const target = await fragment.services.browserRunSessions.createTarget(session.sessionId, {
  url: "https://fragno.dev",
});

const targets = await fragment.services.browserRunSessions.listTargets(session.sessionId);
await fragment.services.browserRunSessions.activateTarget(session.sessionId, target.id);
await fragment.services.browserRunSessions.closeTarget(session.sessionId, target.id);
await fragment.services.browserRunSessions.close(session.sessionId);
```

Session methods are `create`, `list`, `get`, and `close`. Target methods are `createTarget`,
`listTargets`, `getTarget`, `activateTarget`, and `closeTarget`.

## Routes

### Browser Run

- `POST /browser-run/extract`
- `POST /browser-run/capture`
- `POST /browser-run/crawl`
- `POST /browser-run/sessions`
- `GET /browser-run/sessions`
- `GET /browser-run/sessions/:sessionId`
- `DELETE /browser-run/sessions/:sessionId`
- `POST /browser-run/sessions/:sessionId/targets`
- `GET /browser-run/sessions/:sessionId/targets`
- `GET /browser-run/sessions/:sessionId/targets/:targetId`
- `POST /browser-run/sessions/:sessionId/targets/:targetId/activate`
- `DELETE /browser-run/sessions/:sessionId/targets/:targetId`

### Workers for Platforms

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

`createCloudflareFragmentClients()` exposes the deployment clients:

- `useApps`
- `useApp`
- `useAppDeployments`
- `useDeployment`
- `useQueueDeployment`

It also exposes Browser Run Quick Action helpers:

- `useBrowserRunExtract`
- `captureBrowserRun`
- `useBrowserRunCrawl`

Browser session helpers are:

- `useBrowserRunSessions`
- `useBrowserRunSession`
- `useCreateBrowserRunSession`
- `useCloseBrowserRunSession`
- `useBrowserRunTargets`
- `useBrowserRunTarget`
- `useCreateBrowserRunTarget`
- `useActivateBrowserRunTarget`
- `useCloseBrowserRunTarget`

Framework entrypoints are available at `@fragno-dev/cloudflare-fragment/react`, `./vue`, `./svelte`,
`./solid`, and `./vanilla`.

## Development

```bash
pnpm exec turbo types:check --filter=./packages/cloudflare-fragment --output-logs=errors-only
pnpm exec turbo test --filter=./packages/cloudflare-fragment --output-logs=errors-only
pnpm exec turbo build --filter=./packages/cloudflare-fragment --output-logs=errors-only
```
