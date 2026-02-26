# pi-fragment

A Fragno fragment that runs Pi agents using workflow-backed sessions with registry-based config.

## Features

- Session lifecycle (create, list, fetch)
- Workflow-backed agent turns (history stored in workflow steps)
- Registry-driven agent + tool configuration
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
- `defaultSteeringMode`: optional default for agent steering mode

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
