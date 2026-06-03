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
- `workflows`: custom Pi workflow definitions registered with `.withWorkflow(...)`

## Custom Pi workflows

Pi workflows are durable TypeScript workflows over the workflows fragment. Use stable step names,
pass message history explicitly between agent runs, and wrap concurrent branches in a named parent
`ctx.do(...)` step so replay can recover the same step tree.

### Sequential research → write → approve

```ts
import { z } from "zod";
import { definePiWorkflow } from "@fragno-dev/pi-fragment";

const researchWriteApprove = definePiWorkflow(
  {
    name: "research-write-approve",
    schema: z.object({ topic: z.string() }),
  },
  async (ctx) => {
    const research = await ctx.agentStep("researcher").prompt("research", {
      input: { text: `Research ${ctx.params.topic}.` },
    });

    const draft = await ctx.agentStep("writer").prompt("draft", {
      input: { text: "Write a concise answer using the research." },
      messages: research.messages,
    });

    const approval = await ctx.waitForEvent("approval", {
      allowed: ["prompt", "complete"],
    });

    if (approval.kind === "prompt") {
      const revision = await ctx.agentStep("writer").prompt("revise", {
        input: approval.input,
        messages: draft.messages,
      });
      return { messages: revision.messages };
    }

    return { messages: draft.messages };
  },
);
```

Register it with the same builder used for agents and tools:

```ts
const pi = createPi()
  .withAgent("researcher", researcher)
  .withAgent("writer", writer)
  .withWorkflow(researchWriteApprove)
  .build();
```

Create a session by selecting the workflow and passing schema-validated input:

```json
{
  "workflow": "research-write-approve",
  "input": { "topic": "durable LLM workflows" }
}
```

### Decision tool → branch to an agent

Use `definePiTool(...)` to type structured tool details. Passing the tool to `stopOnTools` makes the
agent run stop after that handoff tool result, so workflow code can branch on `details`.

```ts
import { Type } from "typebox";
import { z } from "zod";
import { definePiTool, definePiWorkflow } from "@fragno-dev/pi-fragment";

const classifyRequest = definePiTool({
  name: "classify_request",
  description: "Classify an incoming support request",
  parameters: Type.Object({ request: Type.String() }),
  handoff: true,
  resultSchema: z.object({
    kind: z.enum(["bug", "feature", "question"]),
    confidence: z.number(),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Request classified." }],
      details: { kind: "question", confidence: 0.9 },
      terminate: true,
    };
  },
});

const triageWorkflow = definePiWorkflow(
  { name: "triage-request", schema: z.object({ request: z.string() }) },
  async (ctx) => {
    const triage = await ctx.agentStep("triage").prompt("triage", {
      input: { text: ctx.params.request },
      stopOnTools: [classifyRequest],
    });

    const classification = triage.toolCalls(classifyRequest).latest();

    switch (classification.details.kind) {
      case "bug":
        return ctx.agentStep("debugger").prompt("debug", {
          input: { text: ctx.params.request },
          messages: triage.messages,
        });
      case "feature":
        return ctx.agentStep("planner").prompt("plan", {
          input: { text: ctx.params.request },
          messages: triage.messages,
        });
      case "question":
        return ctx.agentStep("support").prompt("answer", {
          input: { text: ctx.params.request },
          messages: triage.messages,
        });
    }
  },
);
```

### Parallel reviewers → merge

Put `Promise.all`, `Promise.race`, or `Promise.any` inside a named parent step. Each branch still
uses its own stable child step name.

```ts
const parallelReviewWorkflow = definePiWorkflow(
  { name: "parallel-review", schema: z.object({ draft: z.string() }) },
  async (ctx) => {
    const [security, clarity, correctness] = await ctx.do("parallel-reviews", async () =>
      Promise.all([
        ctx.agentStep("security-reviewer").prompt("security-review", {
          input: { text: ctx.params.draft },
        }),
        ctx.agentStep("clarity-reviewer").prompt("clarity-review", {
          input: { text: ctx.params.draft },
        }),
        ctx.agentStep("correctness-reviewer").prompt("correctness-review", {
          input: { text: ctx.params.draft },
        }),
      ]),
    );

    return ctx.agentStep("editor").prompt("merge-reviews", {
      input: { text: "Merge reviewer feedback into a final answer." },
      messages: [...security.messages, ...clarity.messages, ...correctness.messages],
    });
  },
);
```

### Replay and step naming rules

- Step names must be deterministic string literals or derived from already completed durable data.
  Do not use random IDs, current time, or partial streamed LLM output in step names.
- Agent calls do not mutate shared workflow-level message state. Pass `messages` into each step and
  use the returned `messages` when composing later steps.
- Concurrent combinators must be nested under a parent `ctx.do("stable-name", ...)` step.
- Handoff/decision tools should set `handoff: true` and normally return `terminate: true`; pass them
  through `stopOnTools` when a workflow branch needs the first structured tool result.

## Routes

- `POST /workflows/:workflowName/sessions`
- `GET /workflows/:workflowName/sessions`
- `GET /workflows/:workflowName/sessions/:sessionId`
- `GET /workflows/:workflowName/sessions/:sessionId/events`
- `GET /workflows/:workflowName/sessions/:sessionId/export/pi-jsonl`
- `POST /workflows/:workflowName/sessions/:sessionId/command`

`POST /workflows/:workflowName/sessions/:sessionId/command` accepts a discriminated command body
such as `{ kind: "prompt", input: { text: "hello" } }`, `{ kind: "continue" }`, or
`{ kind: "complete", reason: "done" }`. It returns `202 Accepted` with a status-only ACK payload.
Fetch `GET /workflows/:workflowName/sessions/:sessionId` to read the Pi-shaped session detail
payload: `agent.state.messages` plus persisted `agent.events`. Durable resume is based on the agent
configuration/system prompt and the latest committed `AgentMessage[]` transcript.

Use `GET /workflows/:workflowName/sessions/:sessionId/events` with `Accept: application/x-ndjson` to
stream live raw Pi `AgentEvent` frames. Fragment-owned stream control frames are limited to
`snapshot`, `settled`, and `inactive`.

Export a session as a Pi-compatible JSONL file:

```sh
curl "$BASE_URL/workflows/$WORKFLOW_NAME/sessions/$SESSION_ID/export/pi-jsonl" \
  -o "pi-session-$SESSION_ID.jsonl"
```

The exported Pi `cwd` is fixed to `/workspace` by design; callers cannot override it with a query
parameter.

## Client usage

```ts
import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

const pi = createPiFragmentClient({ baseUrl: "/" });

const { data: sessions } = pi.useSessions({ path: { workflowName: "interactive-chat-workflow" } });
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
