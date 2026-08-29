# Backoffice system automations `500` incident report

Date investigated: 2026-08-26

Affected URL: `https://backoffice.rejot.dev/backoffice/automations/system/system/dashboard`

## Summary

The system automations dashboard returned `500 Unexpected Server Error` because the independently
deployed automations route Worker contained two copies of `BackofficeUnavailableError`.

The system scope intentionally has no Upload Durable Object. The file-system contributor expects
that condition and catches `BackofficeUnavailableError` so it can omit the Upload mount. In the
deployed bundle, however, the contributor checked an error class named
`BackofficeUnavailableError$1`, while the runtime kernel threw a separate class named
`BackofficeUnavailableError`. The classes had the same source name and behavior but different
JavaScript identities, so the `instanceof` check returned `false`. The error escaped the intended
fallback and failed the route loader.

This was an application build artifact problem. Cloudflare routing, Worker execution, service
bindings, authentication, and Durable Object storage were operating.

The route-Worker topology described in this report was retired on August 29, 2026 after the complete
Backoffice server was validated in one Worker.

## Impact

- The system automations dashboard could not load.
- Other pages under the system automations scope that execute the same scope-layout loader could
  fail for the same reason.
- The failure affected release `release-20260826-140829`.
- The production telemetry query found repeated failures for both document and `.data` requests.

## Production evidence

The browser reproduced the failure at `2026-08-26T15:01:50Z`. Cloudflare recorded:

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| Account              | `cda934461b3c3f24b4899fc8a100ffe6`     |
| Entry Worker         | `rejot-backoffice`                     |
| Route Worker         | `rejot-backoffice-routes-automations`  |
| Release tag          | `release-20260826-140829`              |
| Trace ID             | `78722f794795afe25b9f2344a8f6a999`     |
| Ray ID               | `a313b6b90a6bd8cc`                     |
| Entry request ID     | `b3b6aab8bbdbdf3811bb35e78c35c4b7`     |
| Route request ID     | `28d1739eca91090e21cafc17aae11814`     |
| Route Worker version | `789b5e47-3a96-407f-a0e5-7ddc2b82897f` |
| Entry Worker version | `c5e43b32-55e9-4aa4-802c-f35532b1b1bc` |
| HTTP status          | `500`                                  |
| Route wall time      | `2085 ms`                              |

The correlated exception was:

```text
BackofficeUnavailableError: UPLOAD is not available in system context.
Supported scopes: org, named, user, project.
    at BackofficeKernel.assertObjectAvailable (index.js:230819:47)
    at BackofficeKernel.scoped (index.js:230871:8)
    at getUploadObject (index.js:138656:21)
    at getUploadConfig (index.js:138662:44)
    at Object.createFileSystem (index.js:137842:30)
    at resolveFileSystem (index.js:140676:55)
    at createMasterFileSystem (index.js:140654:31)
    at async loadAutomationWorkspaceData (index.js:185429:21)
    at async Promise.all (index 0)
    at async loader$6 (index.js:185820:51)
```

Cloudflare reported the Worker invocation outcome as `ok` even though the HTTP response was `500`.
That outcome means the Worker runtime completed the invocation and produced a response. It does not
mean the application request succeeded.

## Request path

At the time of the incident, the production deployment assigned this URL to a dedicated automations
route Worker. The request followed this path:

```text
backoffice.rejot.dev
  -> rejot-backoffice
  -> ROUTES_AUTOMATIONS service binding
  -> rejot-backoffice-routes-automations
  -> automations scope-layout loader
  -> loadAutomationWorkspaceData
  -> createBackofficeFileSystem
  -> createMasterFileSystem
  -> Upload file contributor
  -> kernel.scoped("UPLOAD", system scope, ...)
  -> BackofficeUnavailableError
```

The scope-layout loader calls `loadAutomationWorkspaceData` for system scope in
[`scope-layout.tsx`](../apps/backoffice/app/routes/backoffice/automations/scope-layout.tsx). That
function constructs the master file system before listing system scripts in
[`data.server.ts`](../apps/backoffice/app/routes/backoffice/automations/data.server.ts).

The object policy in
[`object-registry.ts`](../apps/backoffice/app/backoffice-runtime/object-registry.ts) allows Upload
objects for `org`, `named`, `user`, and `project` scopes, but not the singleton physical scope used
by system context. The kernel correctly enforces that policy in
[`kernel.ts`](../apps/backoffice/app/backoffice-runtime/kernel.ts).

## Why the fallback failed

The source Upload contributor already handles an unavailable scoped Upload object:

```ts
try {
  return ctx.kernel.scoped("UPLOAD", ctx.execution.scope, ctx.objects.upload);
} catch (error) {
  if (error instanceof BackofficeUnavailableError) {
    return null;
  }
  throw error;
}
```

This code is in [`upload.ts`](../apps/backoffice/app/files/contributors/upload.ts). It had existed
since June 2026, so the incident was not caused by omitting this catch from the source.

The exact artifact uploaded by the deployment script was
`apps/backoffice/dist/routes_automations/index.js`. It contains two independently emitted copies of
the kernel module:

- The Upload contributor checks `error instanceof BackofficeUnavailableError$1` near line 138658.
- The active route runtime creates `new BackofficeKernel(runtime)` near line 254148.
- That kernel throws the unsuffixed `BackofficeUnavailableError` near line 230819.

JavaScript class identity is based on the constructor object, not the class name. Therefore:

```text
error instanceof BackofficeUnavailableError$1 === false
```

The production stack line `230819` independently identifies the unsuffixed kernel copy as the
throwing implementation. This connects the observed exception directly to the duplicate-class
artifact rather than merely inferring it from the source.

## How the incident was investigated

1. Mapped the failing pathname to `rejot-backoffice-routes-automations` using the repository's
   Worker topology.
2. Queried Cloudflare Worker settings for the entry and route Workers. Both had persisted logs and
   traces enabled at a sampling rate of `1` and both used release `release-20260826-140829`.
3. Reloaded the shared browser page to create a fresh failure with a known timestamp.
4. Queried Cloudflare Workers Observability around that timestamp and found matching `500` events
   for both the entry Worker and route Worker.
5. Correlated those events through trace `78722f794795afe25b9f2344a8f6a999` and expanded the route
   invocation logs to recover the exception and stack.
6. Followed the stack into the source policy, scope loader, master file system, and Upload
   contributor.
7. Confirmed that the source contained an intended `BackofficeUnavailableError` fallback, which
   contradicted the production behavior.
8. Initially inspected `build/server/automations/index.js`, then checked the deployment script and
   found that production uploads `dist/routes_automations/wrangler.json` and its adjacent `index.js`
   instead.
9. Inspected that exact deployment artifact and found the two error classes. The production stack
   line matched the class that the Upload contributor did not catch.

## Reproducing the telemetry query

Use the Cloudflare Workers Observability query endpoint:

```text
POST /accounts/cda934461b3c3f24b4899fc8a100ffe6/workers/observability/telemetry/query
```

The focused trace query body is:

```json
{
  "queryId": "adhoc-backoffice-trace",
  "view": "events",
  "limit": 500,
  "parameters": {
    "datasets": [],
    "filters": [
      {
        "key": "$metadata.traceId",
        "operation": "eq",
        "type": "string",
        "value": "78722f794795afe25b9f2344a8f6a999"
      }
    ]
  },
  "timeframe": {
    "from": 1787756500000,
    "to": 1787756520000
  }
}
```

To find other occurrences, query events with:

```json
{
  "queryId": "adhoc-upload-system-errors",
  "view": "events",
  "limit": 200,
  "parameters": {
    "datasets": [],
    "filters": [
      {
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": "rejot-backoffice-routes-automations"
      }
    ],
    "needle": {
      "value": "UPLOAD is not available in system context"
    }
  },
  "timeframe": {
    "from": 1787616000000,
    "to": 1787756700000
  }
}
```

## Remediation

The root fix is to prevent the route-worker build from emitting duplicate application modules that
carry identity-sensitive classes. The deployed automations artifact should contain one canonical
`BackofficeKernel` module and one `BackofficeUnavailableError` constructor.

As defense in depth, expected cross-boundary errors should expose a stable discriminant, such as a
literal error code and a predicate that validates the error at the boundary. A class-name check
alone would be weaker because unrelated errors can share a name. The fallback should not depend on
`instanceof` when build, RPC, or realm boundaries can duplicate constructors.

## Verification after remediation

1. Build the independently deployed route Workers.
2. Inspect `dist/routes_automations/index.js` and verify that the kernel module is emitted once, or
   that the Upload fallback uses the stable error discriminant.
3. Run the automations route tests for system, organization, user, and project scopes.
4. Deploy the entry and automations route Workers with the same release tag.
5. Load the affected dashboard and its `.data` route; both must return a non-error response.
6. Query Cloudflare telemetry for the new trace and verify that no
   `UPLOAD is not available in system context` event escaped the contributor.

No production data repair is required. The policy rejection happened before an Upload object was
addressed or mutated.
