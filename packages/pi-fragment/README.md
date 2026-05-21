# pi-fragment

A Fragno fragment that runs Pi agents using workflow-backed sessions with registry-based config.

## Features

- Session lifecycle (create, list, fetch)
- Workflow-backed Pi agent sessions with restorable `AgentMessage[]` transcripts
- Registry-driven agent + tool configuration
- Framework-level tools with optional factories and stateful tool config
- Minimal API surface for sessions + messages

## Server usage

```ts
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { createWorkflowsFragment } from "@fragno-dev/workflows";
import { getModel } from "@earendil-works/pi-ai";
import { createPi, createPiFragment } from "@fragno-dev/pi-fragment";

const pi = createPi()
  .withTool("search", async () => ({
    name: "search",
    description: "Lookup references",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    handler: async ({ query }: { query: string }) => `Result for ${query}`,
  }))
  .withAgent("support-agent", {
    systemPrompt: "You are a helpful support agent.",
    model: getModel("openai", "gpt-4.1"),
    tools: ["search"],
  })
  .build();

const workflowsFragment = createWorkflowsFragment(
  {
    workflows: pi.workflows,
    runtime: defaultFragnoRuntime,
  },
  { databaseAdapter: new SqlAdapter({ filename: "./pi.db" }), mountRoute: "/api/workflows" },
);

const fragment = createPiFragment(
  pi.config,
  { databaseAdapter: new SqlAdapter({ filename: "./pi.db" }) },
  { workflows: workflowsFragment.services },
);

// Example: Next.js route handlers
export const { GET, POST, PATCH } = fragment.handlersFor("next-js");
```

Workflows are executed via the workflows fragment durable hook dispatcher. For a full example, see
`apps/review-mode/workers/pi-fragment.do.ts`.

### Config highlights

- `agents`: registry of agent definitions (name, system prompt, model, tools)
- `tools`: registry of tool factories
- `toolConfig`: optional config shared with tool factories at runtime
- `defaultSteeringMode`: optional default for agent steering mode

## Routes

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/events`
- `GET /sessions/:sessionId/export/pi-jsonl`
- `POST /sessions/:sessionId/command`

`POST /sessions/:sessionId/command` accepts a discriminated command body such as
`{ kind: "prompt", input: { text: "hello" } }`, `{ kind: "continue" }`, or
`{ kind: "complete", reason: "done" }`. It returns `202 Accepted` with a status-only ACK payload.
Fetch `GET /sessions/:sessionId` to read the Pi-shaped session detail payload:
`agent.state.messages` plus persisted `agent.events`. Durable resume is based on the agent
configuration/system prompt and the latest committed `AgentMessage[]` transcript.

Use `GET /sessions/:sessionId/events` with `Accept: application/x-ndjson` to stream live raw Pi
`AgentEvent` frames. Fragment-owned stream control frames are limited to `snapshot`, `settled`, and
`inactive`.

Export a session as a Pi-compatible JSONL file:

```sh
curl "$BASE_URL/sessions/$SESSION_ID/export/pi-jsonl" \
  -o "pi-session-$SESSION_ID.jsonl"
```

The exported Pi `cwd` is fixed to `/workspace` by design; callers cannot override it with a query
parameter.

## Client usage

```ts
import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

const pi = createPiFragmentClient({ baseUrl: "/" });

const { data: sessions } = pi.useSessions();
const createSession = pi.useCreateSession();
const sendMessage = pi.useSendMessage();
```

## CLI

Use the CLI to list sessions, create a session, fetch details, or send messages.

```bash
# From the workspace
pnpm -C packages/pi-fragment build
node packages/pi-fragment/bin/run.js --help
```

```bash
# Use the CLI
fragno-pi --help
```

## Development

```bash
pnpm --filter @fragno-dev/pi-fragment test
pnpm --filter @fragno-dev/pi-fragment build
```
