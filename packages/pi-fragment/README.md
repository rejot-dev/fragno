# pi-fragment

A Fragno fragment that runs Pi agents using workflow-backed sessions with registry-based config.

## Features

- Session lifecycle (create, list, fetch)
- Workflow-backed agent turns (history stored in workflow steps)
- Registry-driven agent + tool configuration
- Automatic tool call capture + deterministic replay from persisted workflow step state
- Framework-level side-effect reducers (including built-in bash VFS reconstruction)
- Minimal API surface for sessions + messages

## Server usage

```ts
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { createWorkflowsFragment } from "@fragno-dev/workflows";
import { getModel } from "@mariozechner/pi-ai";
import { createPi, createPiFragment, defineAgent } from "@fragno-dev/pi-fragment";

const pi = createPi()
  .agent(
    defineAgent("support-agent", {
      systemPrompt: "You are a helpful support agent.",
      model: getModel("openai", "gpt-4.1"),
      tools: ["search"],
    }),
  )
  .tool("search", async () => ({
    name: "search",
    description: "Lookup references",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    handler: async ({ query }: { query: string }) => `Result for ${query}`,
  }))
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
- `toolSideEffectReducers`: optional reducers keyed by tool name for reconstructing runtime state
- `defaultSteeringMode`: optional default for agent steering mode

## Tool Replay Middleware Contract

Tool calls are persisted automatically in each `assistant-*` workflow step result. Tools do not need
to write workflow state directly.

- Stable key: `sessionId:turnId:toolCallId`
- Journal fields: `version`, `toolName`, `args`, `result`, `isError`, `source`, `capturedAt`, `seq`
- Replay: duplicate tool calls with the same stable key are short-circuited and reuse persisted
  results
- Error parity: replayed failed calls preserve `isError` behavior

### Reducers for Stateful Tools

For stateful runtimes (for example bash virtual filesystems), register a reducer so tool factories
receive reconstructed state through `ctx.replay.sideEffects`.

```ts
const pi = createPi()
  .toolSideEffectReducer("bash", (state, entry) => {
    // Apply persisted bash tool details in deterministic order.
    const previous = typeof state === "object" && state ? state : {};
    const details =
      entry.result.details && typeof entry.result.details === "object" ? entry.result.details : {};
    return { ...previous, ...details };
  })
  .build();
```

`@fragno-dev/pi-fragment` includes a default `bash` reducer that replays common
`cwd/files/writes/deletes` detail payloads. Custom reducers can extend or override this behavior per
tool.

## Routes

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:sessionId`
- `POST /sessions/:sessionId/messages`

`POST /sessions/:sessionId/messages` is asynchronous. It returns `202 Accepted` with a status-only
ACK payload. Fetch `GET /sessions/:sessionId` to read assistant messages, trace, and summaries once
the workflow processes the message.

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
