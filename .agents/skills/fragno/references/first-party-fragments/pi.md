# Pi Fragment (@fragno-dev/pi-fragment)

## Summary

Workflow-backed AI agent sessions with durable state, deterministic tool replay, and typed client
APIs for sessions and messages.

## Use when

- You want to embed AI agents directly into your product.
- Agent turns must survive retries, restarts, and long-running execution.
- Tool calls need to be replay-safe so side effects do not run twice.

## Config

The fragment config defines agent and tool registries.

What you provide:

- `agents`: registry of agent definitions created with `defineAgent()`.
- `tools`: registry of tool factories.
- `defaultSteeringMode` (optional): default steering mode for sessions/messages.
- `toolSideEffectReducers` (optional): reducers for reconstructing stateful tool side effects.
- `logging` (optional): internal pi-fragment diagnostics.

What the fragment needs via options/services:

- `databaseAdapter`: required for sessions and persisted workflow state.
- `mountRoute` (optional): choose where Pi routes are mounted.
- `services.workflows`: required; Pi depends on a Workflows fragment instance.

## What you get

- Durable agent sessions stored in your database.
- Asynchronous message processing through workflows.
- Persisted tool-call journal with deterministic replay.
- Typed client hooks for listing sessions, creating sessions, and sending messages.

## Docs

There is not yet a published Markdown docs section for Pi. Use these local references first:

- `packages/pi-fragment/README.md`
- `packages/pi-fragment/CLI.md`
- `packages/pi-fragment/src/index.ts`
- `packages/pi-fragment/src/client/clients.ts`
- `apps/docs/app/routes/pi.tsx`

Also read Workflows docs/reference because Pi depends on it:

- `curl -L "https://fragno.dev/docs/workflows/quickstart" -H "accept: text/markdown"`
- `./references/first-party-fragments/workflows.md`

## Prerequisites

- A database and `@fragno-dev/db` adapter.
- `@fragno-dev/workflows` configured with a runner/dispatcher.
- A model/provider setup for your agent definitions.

## Install

`npm install @fragno-dev/pi-fragment @fragno-dev/workflows @fragno-dev/db`

## Server setup

1. Build the Pi registry with `createPi()`.
2. Create a Workflows fragment for `pi.workflows`.
3. Instantiate Pi with
   `createPiFragment(pi.config, { databaseAdapter, mountRoute? }, { workflows: workflowsFragment.services })`.
4. Mount both the Workflows and Pi routes.
5. Generate and apply DB migrations.

Example server module:

```ts
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createPi, createPiFragment, defineAgent } from "@fragno-dev/pi-fragment";
import { createWorkflowsFragment } from "@fragno-dev/workflows";
import { databaseAdapter } from "./db";

const pi = createPi()
  .agent(
    defineAgent("support-agent", {
      systemPrompt: "You are a helpful support agent.",
      model,
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
  { databaseAdapter, mountRoute: "/api/workflows" },
);

export const piFragment = createPiFragment(
  pi.config,
  { databaseAdapter, mountRoute: "/api/pi" },
  { workflows: workflowsFragment.services },
);
```

## Database migrations

Generate migrations from the server module that wires Pi and Workflows, or generate them from each
fragment module and apply both sets.

Examples:

- `npx fragno-cli db generate lib/pi.ts --format drizzle -o db/pi.schema.ts`
- `npx fragno-cli db generate lib/pi.ts --output migrations/001_pi.sql`

## Client setup

Use the framework-specific client entrypoint, e.g. React:

```ts
import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

export const piClient = createPiFragmentClient({
  mountRoute: "/api/pi",
});
```

## Routes and hooks

Routes:

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/active`
- `POST /sessions/:sessionId/messages`

Hooks/stores:

- `useSessions`
- `useSessionDetail`
- `useSession`
- `useCreateSession`
- `useActiveSession`
- `useSendMessage`

## Operational notes

- `POST /sessions/:sessionId/messages` is asynchronous and returns an acknowledgment payload.
- Session detail/active endpoints are how the client observes workflow progress.
- If you use stateful tools, register a side-effect reducer so replay reconstructs tool state.

## Common pitfalls

- Mounting Pi without mounting/configuring the Workflows fragment.
- Forgetting to wire a runner/dispatcher, so sessions never advance.
- Treating message submission as synchronous instead of polling/streaming session state.

## Next steps

- Add product-specific tools and reducers.
- Build a session UI on top of `useSession` / `useActiveSession`.
