# Backoffice organization files slow-request incident report

Date investigated: 2026-08-27

Affected URL: `https://backoffice.rejot.dev/backoffice/files/org/wilcos-organization.data`

## Summary

The organization files data request returned `200`, but took `6.940 s` before the response reached
the browser. Almost all of that time was server-side waiting in the independently deployed files
route Worker:

- The files route Worker used `6.938 s` wall time and `78 ms` CPU time.
- Cloudflare measured `6.871 s` to first byte.
- The entry Worker used `6.940 s` wall time and `0 ms` CPU time because it only awaited the route
  Worker service binding.

The request was slow because loading the `/static` files tree dynamically generated codemode type
artifacts. Artifact generation checked every configurable Backoffice capability sequentially and
contacted several organization-scoped Durable Objects. The trace includes calls to Telegram, Resend,
Reson8, Upload, Pi through Automations, and MCP before the files response completed.

This was not response-transfer latency, CPU saturation, or one slow database query. It was
application-level fan-out on the request's critical path, with likely Durable Object activation and
initialization costs. The trace also exposed undisposed RPC stubs that make several RPC spans appear
to last until the route ends; those spans cannot be treated as individual method timings.

## Impact

- The organization files view waited approximately seven seconds for its `.data` response.
- The response succeeded and the returned file data was complete.
- Any org or project files request that generates the same dynamic static artifacts can execute the
  same capability-discovery fan-out.
- Only one matching request was present in the preceding hour, so production telemetry could not
  establish a warm-request baseline or percentile distribution.

## Production evidence

Cloudflare recorded the request at approximately `2026-08-27T07:02:06.521Z`:

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| Account              | `cda934461b3c3f24b4899fc8a100ffe6`     |
| Trace ID             | `329410058323f3ab8d401d60c5654249`     |
| Ray ID               | `a3193572bcfafc46`                     |
| Entry Worker         | `rejot-backoffice`                     |
| Files route Worker   | `rejot-backoffice-routes-files`        |
| Entry Worker version | `b381c2b0-0a7e-46d5-a9d6-447c28607ac6` |
| Route Worker version | `d39b2339-83a6-48e3-8d34-ee23b22b494e` |
| Entry request ID     | `9629d3855ae4a430bd892a2600565c8c`     |
| Route request ID     | `75d28a3e2ff95f45be3b1f1983cc2596`     |
| HTTP status          | `200`                                  |
| Entry wall time      | `6940 ms`                              |
| Route wall time      | `6938 ms`                              |
| Route CPU time       | `78 ms`                                |
| Time to first byte   | `6871 ms`                              |
| Cloudflare colo      | `AMS`                                  |

The difference between route wall time and CPU time is the main performance signal. More than `98%`
of the route's elapsed time was spent awaiting other work rather than executing JavaScript.

## Request path

The production request followed this path:

```text
backoffice.rejot.dev
  -> rejot-backoffice
  -> files route Worker service binding
  -> rejot-backoffice-routes-files
  -> loadFilesExplorerData
  -> createFilesOverviewCollections
  -> loadCollectionSources
     -> /workspace Upload collection tree
     -> /static collection tree
        -> createCodemodeStaticArtifacts
        -> sequential capability getStatus calls
        -> optional MCP server discovery
```

The route creates `/static` and `/workspace` collections in
[`file-collections.server.ts`](../apps/backoffice/app/routes/backoffice/files/file-collections.server.ts).
It then loads their trees concurrently with `Promise.allSettled` in
[`data.ts`](../apps/backoffice/app/routes/backoffice/files/data.ts).

The `/workspace` collection uses Upload. The `/static` collection is nominally immutable, but its
codemode declarations are generated dynamically from current capability configuration through
`createCodemodeStaticArtifactsResolver`.

## Why static file generation is expensive

[`static-codemode-artifacts.ts`](../apps/backoffice/app/fragno/codemode/static-codemode-artifacts.ts)
contains this request-critical loop:

```ts
for (const capability of backofficeCapabilities) {
  const connection = capability.contributions.connection;
  // ...
  const status = await connection.getStatus({
    objects,
    config,
    scope: { kind: "org", orgId },
    orgId,
    origin,
  });
  // ...
}
```

Each `await` completes before the next capability is checked. The trace confirms calls involving:

- Telegram
- Resend
- Reson8
- Upload
- Pi through the Automations object
- MCP server discovery

Pi capability discovery calls `objects.automations.for(scope).getPiRuntimeState()` in
[`pi.ts`](../apps/backoffice/app/fragno/backoffice-capabilities/capabilities/pi.ts). That method
ensures the Automations object is configured. On initialization, the object creates its runtime and
migrates the workflows, automation, and Pi fragments sequentially in
[`automations.do.ts`](../apps/backoffice/workers/automations.do.ts).

If MCP is configured, artifact generation then lists MCP servers after the capability loop. This
adds another Durable Object call before the static tree can be returned.

## Storage activity

The trace contained repeated `internal.outbox.list` activity while the request was open:

| Operation                                                  | Span count |
| ---------------------------------------------------------- | ---------- |
| `durable_object_storage_exec`                              | 39         |
| `durable_object_storage_transaction`                       | 38         |
| `fragno.db.service.internal.outbox.list.retrieve`          | 37         |
| `fragno.db.service.internal.outbox.list.transformRetrieve` | 37         |

The outbox list operations occurred at an approximately `100 ms` cadence. This matches the outbox
stream pump interval in
[`internal-fragment.routes.ts`](../packages/fragno-db/src/fragments/internal-fragment.routes.ts). No
direct child operation exceeded `10 ms`, so the evidence does not support a slow SQL query as the
cause of the seven-second response.

These polling spans overlap the slow request, but summed span duration is not wall time. They should
be treated as concurrent stream activity rather than seven seconds of database execution.

## RPC telemetry caveat

The files route emitted this warning:

```text
An RPC stub was not disposed properly. You must call dispose() on all stubs in order to let the
other side know that you are no longer using them.
```

Cloudflare recorded canceled RPC invocations including:

- `Automations.init`: one invocation with `6915 ms` wall time and another with `3244 ms`
- `Telegram.init`: `5573 ms` wall time
- `Mcp.init`: `240 ms` wall time

Those durations mostly describe how long returned RPC stubs remained alive. They end near the route
completion and have outcome `canceled`, so they do not prove that the corresponding `init` methods
executed for that long. Reading them as ordinary method spans would incorrectly attribute the whole
request to Automations.

The undisposed stubs are independently actionable because they pollute trace parentage and prevent
reliable per-capability latency attribution. The warning does not, by itself, prove that stub
lifetime caused the user-visible wait.

## Observed facts and inference

Observed:

- The route took `6938 ms`, used `78 ms` CPU, and did not produce the first byte for `6871 ms`.
- Static artifact generation synchronously awaits capability status checks in a serial loop.
- The trace contains the capability and Durable Object calls expected from that loop.
- Upload file listing completed successfully; its Worker invocation used `129 ms` wall time.
- Resend and Reson8 admin-config invocations used `35 ms` and `12 ms` wall time respectively.
- No direct storage child span exceeded `10 ms`.
- Cloudflare reported undisposed RPC stubs and canceled `init` invocations.

Inference:

- The remaining wall time is most consistent with Durable Object activation, initialization,
  scheduling, and sequential cross-object waits that are not fully represented by child method
  spans.
- This request likely paid first-use costs because it touched several organization-scoped objects,
  but the available sample does not prove how much faster a warm request would be.

## How the request was investigated

1. Queried Workers Observability for the exact URL in a narrow window around the browser request.
2. Correlated the entry and files route Workers through trace `329410058323f3ab8d401d60c5654249`.
3. Compared wall time, CPU time, and time to first byte to separate server waiting from browser
   transfer and computation.
4. Expanded the full trace and filtered spans longer than `50 ms`.
5. Grouped direct child spans by operation name and counted the repeated outbox activity.
6. Grouped Worker invocation events by trigger to identify the Durable Objects touched by the
   request.
7. Inspected the files loader, static artifact resolver, capability implementations, Automations
   initialization, and outbox stream implementation.
8. Queried the previous hour for the same route and found no other matching request to use as a
   baseline.

## Reproducing the telemetry query

Use the Cloudflare Workers Observability query endpoint:

```text
POST /accounts/cda934461b3c3f24b4899fc8a100ffe6/workers/observability/telemetry/query
```

The focused trace query body is:

```json
{
  "queryId": "adhoc-slow-files-data-trace",
  "view": "events",
  "limit": 500,
  "parameters": {
    "datasets": [],
    "filters": [
      {
        "key": "$metadata.traceId",
        "operation": "eq",
        "type": "string",
        "value": "329410058323f3ab8d401d60c5654249"
      }
    ]
  },
  "timeframe": {
    "from": 1787814110000,
    "to": 1787814210000
  }
}
```

To count the direct operations associated with one RPC span, add a parent-span filter and use the
`calculations` view:

```json
{
  "queryId": "adhoc-automations-init-child-counts",
  "view": "calculations",
  "parameters": {
    "datasets": [],
    "filters": [
      {
        "key": "$metadata.traceId",
        "operation": "eq",
        "type": "string",
        "value": "329410058323f3ab8d401d60c5654249"
      },
      {
        "key": "$metadata.parentSpanId",
        "operation": "eq",
        "type": "string",
        "value": "95d59222826bf346"
      }
    ],
    "calculations": [
      { "operator": "count", "alias": "count" },
      {
        "operator": "sum",
        "key": "durationMS",
        "keyType": "number",
        "alias": "sum_ms"
      }
    ],
    "groupBys": [{ "type": "string", "value": "name" }],
    "orderBy": { "value": "count", "order": "desc" }
  },
  "timeframe": {
    "from": 1787814126000,
    "to": 1787814134000
  }
}
```

## Remediation options

The root performance fix is to remove live capability discovery from static file-tree loading.
Options include:

1. Generate the codemode artifact from a cached capability snapshot keyed by organization and
   configuration revision.
2. Persist the generated artifact when capability configuration changes instead of regenerating it
   on every files request.
3. If live discovery remains necessary, execute independent capability status checks concurrently
   and place explicit timeouts around external object calls.
4. Avoid generating dynamic codemode artifacts until the user selects or downloads the relevant
   file, rather than while listing the static tree.

Independently, dispose all RPC stubs deterministically. Then add spans around capability discovery
and runtime initialization so future traces expose actual method latency rather than stub lifetime.

## Verification after remediation

1. Exercise the organization files `.data` route with cold and warm Durable Objects.
2. Verify that listing `/static` does not synchronously contact every configurable capability, or
   that the calls run within the intended bounded latency budget.
3. Confirm that Cloudflare no longer emits the RPC-stub disposal warning.
4. Confirm that `init` RPC spans end when their work completes and do not have outcome `canceled`.
5. Compare route wall time and time to first byte over multiple requests.
6. Confirm that generated codemode artifacts still reflect capability configuration changes.

No production data repair is required.
