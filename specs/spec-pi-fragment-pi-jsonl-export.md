# Pi Fragment Pi-Compatible JSONL Export — Spec

## Overview

`@fragno-dev/pi-fragment` should expose a server-side export route that returns a Pi-compatible
JSONL session file for an existing fragment session. The export is intended for portability: a
conversation that happened inside pi-fragment can be saved as a `.jsonl` file and opened by Pi's
session tooling.

The first implementation exports a linear Pi session snapshot. It does not synthesize Pi branches,
labels, compactions, or extension-specific state because pi-fragment currently reconstructs a linear
message history from workflow history.

## References

- Pi session file format snapshot:
  [`references/pi-session-format.md`](./references/pi-session-format.md)
- pi-fragment route implementation:
  [`../packages/pi-fragment/src/routes.ts`](../packages/pi-fragment/src/routes.ts)
- pi-fragment route schemas and message shape:
  [`../packages/pi-fragment/src/pi/route-schemas.ts`](../packages/pi-fragment/src/pi/route-schemas.ts)
- pi-fragment session reconstruction:
  [`../packages/pi-fragment/src/pi/workflow/reconstruct-session.ts`](../packages/pi-fragment/src/pi/workflow/reconstruct-session.ts)

## Goals

- Add a route that returns a valid Pi v3 JSONL session file.
- Reuse pi-fragment's existing session-detail projection so export output matches the session detail
  route's message history.
- Make the export deterministic and easy to test.
- Prevent API callers from choosing the exported Pi `cwd`.
- Keep the first export format conservative and linear.

## Non-goals

- Import Pi JSONL into pi-fragment.
- Preserve Pi branch trees, compaction entries, labels, or extension custom entries.
- Export live, not-yet-persisted stream frames beyond what the session-detail projection can already
  reconstruct.
- Add a client hook or UI. This is a server/file route first.

## User-facing API

### Route

```http
GET /sessions/:sessionId/export/pi-jsonl
```

The route has no `cwd` query parameter and no request body. API callers cannot change the exported
Pi `cwd`.

### Response

Success:

- Status: `200`
- `content-type: application/x-ndjson; charset=utf-8`
- `content-disposition: attachment; filename="pi-session-<sessionId>.jsonl"`
- Body: newline-delimited JSON, with a trailing newline

Errors reuse the session detail route's error shape:

- `SESSION_NOT_FOUND` with `404`
- `WORKFLOW_INSTANCE_MISSING` with `500`

## CWD decision

The export should write a fixed server-selected `cwd` into the Pi session header:

```ts
const PI_JSONL_EXPORT_CWD = "/workspace";
```

Rationale:

- Backoffice Pi agents already operate against a virtual filesystem where `/workspace` is the
  writable/user-facing working area.
- Pi's JSONL format requires a `cwd`, but pi-fragment sessions are hosted and do not have a real
  local project directory.
- A fixed value keeps the route safe from user-controlled path injection and groups exported
  sessions under a stable Pi session directory if copied into Pi's session store.

If another host later needs a different value, that should be a fragment/server configuration
extension, not a request parameter.

## Export format

The route exports these lines:

1. `SessionHeader`
2. Optional `session_info` entry when the pi-fragment session has a name
3. Optional `model_change` entry derived from the configured agent's model
4. Optional `thinking_level_change` entry derived from the configured agent's thinking level
5. One `message` entry per reconstructed `PiSessionDetail.messages[]` item

The session is linear:

- The first non-header entry has `parentId: null`.
- Every following entry has `parentId` set to the previous entry's `id`.
- Entry ids are deterministic 8-character lowercase hex strings, e.g. `00000001`, `00000002`.

### Header

```json
{
  "type": "session",
  "version": 3,
  "id": "<sessionId>",
  "timestamp": "<createdAt ISO>",
  "cwd": "/workspace"
}
```

### Session name

If `session.name` is non-empty:

```json
{
  "type": "session_info",
  "id": "00000001",
  "parentId": null,
  "timestamp": "<createdAt ISO>",
  "name": "Support case"
}
```

### Messages

Each message entry embeds the reconstructed `AgentMessage` unchanged except for normal JSON
serialization of dates/numbers:

```json
{"type":"message","id":"00000004","parentId":"00000003","timestamp":"<message ISO>","message":{...}}
```

The entry timestamp is derived from `message.timestamp` when it is a finite Unix millisecond value.
Otherwise it falls back to the session `updatedAt`, then `createdAt`.

## Code changes

### 1. Add pure exporter helper

Create:

`packages/pi-fragment/src/pi/pi-jsonl-export.ts`

Responsibilities:

- Define minimal local types for the Pi JSONL entries needed by this export.
- Export `PI_JSONL_EXPORT_CWD = "/workspace"`.
- Export `createPiJsonlExport({ session, agent, messages })`.
- Normalize timestamps and deterministic entry ids.
- Return a string built with `lines.map(JSON.stringify).join("\n") + "\n"`.

### 2. Extract shared session snapshot loading

Refactor `packages/pi-fragment/src/routes.ts` so the existing detail route and the new export route
share the same internal loader. The helper should perform the current work done by
`GET /sessions/:sessionId`:

- Check the pi-fragment `session` row.
- Fetch workflow status.
- Fetch workflow history.
- Restore workflow state when no live state is available.
- Call `projectSessionDetailFromWorkflowHistory(...)`.

Suggested internal shape:

```ts
type PiSessionDetailSnapshot = {
  session: PiSession;
  workflowStatus: PiWorkflowsInstanceStatus;
  detailState: PiAgentLoopSerializableState;
};
```

### 3. Add route

Add to `piRoutesFactory`:

```ts
defineRoute({
  method: "GET",
  path: "/sessions/:sessionId/export/pi-jsonl",
  errorCodes: ["SESSION_NOT_FOUND", "WORKFLOW_INSTANCE_MISSING"],
  handler: async function ({ pathParams }, { error }) {
    // load shared snapshot
    // resolve configured agent by session.agent
    // generate JSONL
    // return new Response(jsonl, { headers: ... })
  },
});
```

The route should not declare `queryParameters`.

### 4. Export helper types if useful

If tests or downstream callers need them, export the helper from
`packages/pi-fragment/src/index.ts`. Otherwise keep it internal.

## Tests

Add coverage in `packages/pi-fragment/src/pi/pi-jsonl-export.test.ts` or a route-focused test file.
Use `callRouteRaw` for the file response.

Required cases:

- Export response has NDJSON content type and attachment filename.
- First line is a Pi v3 `session` header with `cwd: "/workspace"`.
- No request query can change `cwd`; the route does not accept or read a `cwd` parameter.
- Named sessions emit a `session_info` entry.
- Entries form a linear `id`/`parentId` chain.
- User and assistant messages from a completed prompt are present in order.
- Message entry timestamps prefer `message.timestamp`.
- Missing sessions return `SESSION_NOT_FOUND`.

## Documentation updates

Update `packages/pi-fragment/README.md` with a curl example:

```sh
curl "$BASE_URL/sessions/$SESSION_ID/export/pi-jsonl" \
  -o "pi-session-$SESSION_ID.jsonl"
```

Mention that the exported Pi `cwd` is fixed to `/workspace` by design.

## Implementation plan

1. Add the pure JSONL exporter helper and unit tests.
2. Extract shared session-detail snapshot loading from `routes.ts` without changing existing route
   behavior.
3. Add the export route and route tests using `callRouteRaw`.
4. Update README documentation.
5. Validate the pi-fragment package:

```sh
pnpm exec turbo types:check --filter=@fragno-dev/pi-fragment --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-dev/pi-fragment --output-logs=errors-only
pnpm exec turbo build --filter=@fragno-dev/pi-fragment --output-logs=errors-only
```

## Locked decisions

- The route is `GET /sessions/:sessionId/export/pi-jsonl`.
- The export is Pi session format v3.
- The export is a linear snapshot.
- API callers cannot set `cwd`.
- The exported `cwd` is `/workspace`.
