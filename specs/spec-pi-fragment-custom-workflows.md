# Pi Fragment Custom LLM Workflows — Spec and Implementation Plan

## Open Questions

1. Should custom workflow session creation use a new route (for example `/workflow-sessions`) or
   extend `POST /sessions` with a `workflow` field? This plan assumes extending `POST /sessions`.
2. Should workflow decision tools be declared on the tool definition (`handoff: true`) or only per
   agent step (`stopOnTools`)? This plan supports both, with per-step `stopOnTools` taking priority.
3. Should typed tool result details be validated by Pi fragment metadata, or should they remain
   compile-time-only? Pi itself requires TypeBox for tool parameters. TypeBox 1.x is **not**
   Standard Schema-compatible by itself, so this plan keeps tool parameters TypeBox-only and treats
   `resultSchema` as optional Pi-fragment metadata that may be either Standard Schema or TypeBox via
   an explicit adapter.

## Overview

`@fragno-dev/pi-fragment` currently exposes a hardcoded Pi session workflow: wait for a UI command,
run one agent turn, then wait for the next UI command. This is good for chat-style sessions but too
narrow for durable LLM orchestration where several agent steps may run back-to-back, branches depend
on tool results, multiple agents run in parallel, or a workflow races an agent step against a human
approval timeout.

The goal is to add a Pi-specific workflow authoring API that is a thin layer over
`@fragno-dev/workflows`. Pi users should write durable TypeScript workflows with normal async code,
`Promise.all`, `Promise.race`, and `Promise.any`, while Pi supplies ergonomic primitives for agent
runs, user commands, live events, typed tool results, and tool-result-driven branching.

The importable `interactive-chat-workflow` replaces the old built-in agent loop. It uses the same
public Pi workflow primitives as custom workflows and is included only when users explicitly
register it.

## References

- Interactive chat workflow: `packages/pi-fragment/src/pi/workflow/interactive-chat-workflow.ts`
- Current Pi agent runner: `packages/pi-fragment/src/pi/workflow/agent-runner.ts`
- Current Pi DSL/builder: `packages/pi-fragment/src/pi/dsl.ts`
- Current Pi types: `packages/pi-fragment/src/pi/types.ts`
- Current Pi routes: `packages/pi-fragment/src/routes.ts`
- Session reconstruction: `packages/pi-fragment/src/pi/workflow/reconstruct-session.ts`
- Workflows authoring API: `packages/fragment-workflows/src/workflow.ts`
- Workflows history/services: `packages/fragment-workflows/src/definition.ts`
- Pi agent core tool lifecycle types:
  `node_modules/.pnpm/@mariozechner+pi-agent-core@0.73.1_ws@8.20.0_zod@4.3.5/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`

## Goals

1. Let Pi fragment users define custom durable LLM workflows.
2. Keep the Pi API close to the underlying workflows engine: `step.do`, `waitForEvent`, `sleep`,
   `Promise.all`, `Promise.race`, and `Promise.any` should remain visible concepts.
3. Support multiple sequential agent steps without requiring user input between steps.
4. Support parallel, racing, and first-success agent/user/timer steps through native promise
   combinators wrapped in named parent steps.
5. Expose tool call results as first-class structured data so workflow code can choose the next step
   based on a prior tool call.
6. Support typed decision/handoff tools that intentionally return control from an agent to workflow
   code.
7. Preserve the existing chat/session workflow as an importable Pi workflow.
8. Keep session detail and event streaming reconstructable from durable workflow history.

## Non-goals

1. Building a second graph engine or visual node runtime separate from `@fragno-dev/workflows`.
2. Guaranteeing full type inference for every legacy untyped `AgentTool` immediately.
3. Supporting arbitrary dynamic step names. Step names must be stable for workflow replay.
4. Making in-progress agent interruption restart-safe beyond the existing durable command plus live
   best-effort controller model.

## Proposed User API

### Builder registration

```ts
const pi = createPi()
  .withTool("classifyRequest", classifyRequest)
  .withAgent("researcher", researcher)
  .withAgent("writer", writer)
  .withAgent("reviewer", reviewer)
  .withWorkflow(researchThenWriteWorkflow)
  .withWorkflow(parallelReviewWorkflow)
  .build();
```

`createPi().build()` returns the normal Pi fragment config plus a workflows registry containing the
workflows explicitly registered with `.withWorkflow(...)`.

### Define a Pi workflow

```ts
const researchThenWriteWorkflow = definePiWorkflow(
  {
    name: "research-then-write",
    schema: z.object({ topic: z.string() }),
    outputSchema: z.object({ finalAnswer: z.string() }),
  },
  async (ctx) => {
    const research = await ctx.agent("researcher").prompt("research", {
      input: { text: `Research this topic: ${ctx.params.topic}` },
    });

    const draft = await ctx.agent("writer").prompt("draft", {
      input: { text: `Write an answer using:\n\n${ctx.text(research)}` },
      messages: research.messages,
    });

    const approval = await ctx.waitForUser("approval", {
      prompt: "Approve this draft?",
      commands: ["approve", "revise"],
      timeout: "24 hours",
    });

    if (approval.kind === "revise") {
      const revised = await ctx.agent("writer").prompt("revise", {
        input: approval.input,
        messages: draft.messages,
      });
      return { finalAnswer: ctx.text(revised) };
    }

    return { finalAnswer: ctx.text(draft) };
  },
);
```

### Parallel steps

Parallel combinators must be nested under a named parent step. The parent step gives the workflows
runner a stable outer identity, while the nested agent calls create stable child steps.

```ts
const [security, clarity, correctness] = await ctx.step.do("parallel-reviews", async () =>
  Promise.all([
    ctx.agent("security-reviewer").prompt("security-review", { input }),
    ctx.agent("clarity-reviewer").prompt("clarity-review", { input }),
    ctx.agent("correctness-reviewer").prompt("correctness-review", { input }),
  ]),
);
```

This records a step subtree like:

```txt
do:parallel-reviews
do:parallel-reviews>do:security-review
do:parallel-reviews>do:clarity-review
do:parallel-reviews>do:correctness-review
```

### Racing steps

`Promise.race` must also run inside a named parent step. The losing branch may leave suspended child
steps in workflow history, so the enclosing parent step is the durable result boundary the workflow
continues from.

```ts
const result = await ctx.step.do("approval-race", async () =>
  Promise.race([
    ctx.waitForUser("approval", { commands: ["approve", "reject"] }),
    ctx.sleep("approval-timeout", "2 hours").then(() => ({ kind: "timeout" as const })),
  ]),
);
```

### First-success steps

`Promise.any` follows the same rule as `Promise.race`: wrap the combinator in a named parent step
and put all durable branch work inside that parent step.

```ts
const firstUsableDraft = await ctx.step.do("first-usable-draft", async () =>
  Promise.any([
    ctx.agent("fast-writer").prompt("fast-draft", { input }),
    ctx.agent("careful-writer").prompt("careful-draft", { input }),
  ]),
);
```

Do not put `Promise.all`, `Promise.race`, or `Promise.any` directly around top-level Pi workflow
primitives. Sequential steps can remain top-level; concurrent combinators need an explicit parent
`ctx.step.do(...)`.

### Branching on a tool result

```ts
const triage = await ctx.agent("triage").prompt("triage", {
  input: { text: ctx.params.request },
  stopOnTools: [classifyRequest],
});

const classification = triage.toolCalls(classifyRequest).latest();

switch (classification.details.kind) {
  case "bug":
    return ctx.agent("debugger").prompt("debug", {
      input: { text: ctx.params.request },
      messages: triage.messages,
    });
  case "feature":
    return ctx.agent("planner").prompt("plan", {
      input: { text: ctx.params.request },
      messages: triage.messages,
    });
  case "question":
    return ctx.agent("support").prompt("answer", {
      input: { text: ctx.params.request },
      messages: triage.messages,
    });
}
```

## Public Types

### Pi workflow definition

```ts
type PiWorkflowDefinition<TName extends string, TParams, TOutput> = {
  name: TName;
  schema?: StandardSchemaV1;
  outputSchema?: StandardSchemaV1;
  run: (ctx: PiWorkflowContext<TParams>) => Promise<TOutput> | TOutput;
};

function definePiWorkflow<TName extends string, TParams, TOutput>(
  options: {
    name: TName;
    schema?: StandardSchemaV1;
    outputSchema?: StandardSchemaV1;
  },
  run: (ctx: PiWorkflowContext<TParams>) => Promise<TOutput> | TOutput,
): PiWorkflowDefinition<TName, TParams, TOutput>;
```

`definePiWorkflow(...)`, `schema`, and `outputSchema` intentionally match the
`@fragno-dev/workflows` `defineWorkflow(...)` shape. The implementation should overload
`definePiWorkflow(...)` like `defineWorkflow(...)` so `ctx.params` and the return type are inferred
from Standard Schema inputs when schemas are provided.

### Pi workflow context

```ts
type PiWorkflowContext<TParams> = {
  params: TParams;
  sessionId: string;
  event: WorkflowEvent<unknown>;
  step: WorkflowStep;

  agent(name: string): PiWorkflowAgentHandle;

  waitForCommand(
    name: string,
    options?: {
      allowed?: PiSessionCommandPayload["kind"][];
      timeout?: WorkflowDuration;
    },
  ): Promise<PiSessionCommandPayload>;

  waitForUser<TCommand extends string>(
    name: string,
    options: {
      prompt?: string;
      commands: readonly TCommand[];
      timeout?: WorkflowDuration;
    },
  ): Promise<{ kind: TCommand; input?: PiPromptInput }>;

  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;

  text(result: PiAgentStepResult): string;
};
```

`waitForCommand(...)` is the low-level Pi session command primitive. It waits for raw command
transport events such as `prompt`, `continue`, `abort`, `steer`, and `complete`.

`waitForUser(...)` is the high-level user interaction primitive. It must first publish a durable UI
request from inside a named workflow step, then wait for the matching user response. There is no
workflow-level `ctx.emit(...)`; user-authored emissions are only available inside individual
`step.do(...)` callbacks through `tx.emit(...)`.

### Agent handle

```ts
type PiWorkflowAgentHandle = {
  run(name: string, options: PiWorkflowAgentRunOptions): Promise<PiAgentStepResult>;
  prompt(name: string, options: PiWorkflowAgentPromptOptions): Promise<PiAgentStepResult>;
  continue(name: string, options?: PiWorkflowAgentContinueOptions): Promise<PiAgentStepResult>;
};

type PiWorkflowAgentRunOptions = PiWorkflowAgentStepOptions & {
  mode: "prompt" | "continue";
  input?: PiPromptInput;
};

type PiWorkflowAgentPromptOptions = PiWorkflowAgentStepOptions & {
  input: PiPromptInput;
};

type PiWorkflowAgentContinueOptions = PiWorkflowAgentStepOptions;

type PiWorkflowAgentStepOptions = {
  messages?: AgentMessage[];
  systemPrompt?: string;
  step?: WorkflowStepConfig;
  controls?: Array<"abort" | "steer">;
  stopOnTools?: Array<string | PiToolDefinition<any, any>>;
  toolExecution?: "sequential" | "parallel";
};
```

### Agent step result with tools

```ts
type PiAgentStepResult = {
  type: "agent-run";
  stopReason: StopReason;
  messages: AgentMessage[];
  events: AgentEvent[];
  toolCallResults: PiToolCallResult[];
  errorMessage: string | null;

  toolCalls(name: string): PiToolCallAccessor<unknown>;
  toolCalls<TDetails>(tool: PiToolDefinition<any, TDetails>): PiToolCallAccessor<TDetails>;
};

type PiToolCallAccessor<TDetails> = {
  all(): PiToolCallResult<TDetails>[];
  first(): PiToolCallResult<TDetails>;
  latest(): PiToolCallResult<TDetails>;
  maybeFirst(): PiToolCallResult<TDetails> | undefined;
  maybeLatest(): PiToolCallResult<TDetails> | undefined;
};

type PiToolCallResult<TDetails = unknown> = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: AgentToolResult<TDetails>;
  details: TDetails;
  isError: boolean;
};
```

## Tool API

### Typed Pi tool wrapper

Pi tool **parameter** schemas are TypeBox-only because the underlying Pi runtime defines
`Tool<TParameters extends TSchema>` and `AgentTool<TParameters extends TSchema, TDetails>`. The Pi
fragment wrapper must preserve that contract.

```ts
import type { TSchema as TypeBoxSchema } from "typebox";

type PiToolResultSchema<TDetails> = StandardSchemaV1<unknown, TDetails> | TypeBoxSchema;

type PiToolDefinition<TParameters extends TypeBoxSchema, TDetails> = AgentTool<
  TParameters,
  TDetails
> & {
  name: string;
  resultSchema?: PiToolResultSchema<TDetails>;
  handoff?: boolean;
};

function definePiTool<TParameters extends TypeBoxSchema, TDetails>(
  tool: PiToolDefinition<TParameters, TDetails>,
): PiToolDefinition<TParameters, TDetails>;
```

Tools remain compatible with `AgentTool`. `definePiTool` adds type metadata for workflow authors and
optional `handoff` metadata for default `stopOnTools` behavior. `resultSchema` is Pi-fragment
metadata for validating/typing structured tool result details; it does not change Pi's TypeBox tool
parameter requirement. If `resultSchema` is TypeBox, Pi fragment must validate it with TypeBox's
validator APIs or wrap it in an explicit Standard Schema adapter; it cannot pass a raw TypeBox
schema to APIs that require `StandardSchemaV1`.

### Decision/handoff tools

A decision tool is a tool whose structured result is intended to hand control back to workflow code.
It should generally return `terminate: true`, and Pi should be able to enforce this when a tool is
in `stopOnTools`.

```ts
const classifyRequest = definePiTool({
  name: "classify_request",
  label: "Classify request",
  handoff: true,
  parameters: Type.Object({ request: Type.String() }),
  resultSchema: z.object({
    kind: z.enum(["bug", "feature", "question"]),
    confidence: z.number(),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Request classified." }],
      details: { kind: "bug", confidence: 0.91 },
      terminate: true,
    };
  },
});
```

## Execution Model

### Mapping to `@fragno-dev/workflows`

- `definePiWorkflow({ name, schema, outputSchema }, run)` compiles to a normal
  `defineWorkflow({ name, schema, outputSchema }, run)` entry.
- `ctx.params` is derived from the underlying workflow event payload after schema validation.
- `ctx.agent(...).prompt("draft", ...)` maps to `step.do("draft", ...)`; agent step options can
  carry `step?: WorkflowStepConfig` through to the underlying step.
- `ctx.waitForCommand("next", ...)` maps to `step.waitForEvent("next", { type: "command" })` and is
  the low-level raw command transport primitive.
- `ctx.waitForUser("approval", ...)` is high-level UI interaction. It must emit any UI request from
  inside a named `step.do(...)` callback with `tx.emit(...)`, then wait via
  `step.waitForEvent("approval", { type: "user-command" })` or the existing `"command"` transport
  with an agreed payload shape.
- `ctx.sleep(...)` and `ctx.sleepUntil(...)` call the raw workflow step helpers.
- There is no top-level `ctx.emit(...)`; emissions are only available through `tx.emit(...)` inside
  individual workflow steps.
- `Promise.all`, `Promise.race`, and `Promise.any` are allowed only when wrapped in a named parent
  `ctx.step.do(...)`. The parent step establishes the stable outer identity and nested child step
  keys. Pi may later add `ctx.parallel(...)`, `ctx.race(...)`, or `ctx.any(...)` helpers, but those
  helpers must desugar to this parent-step shape.
- `ctx.step` is exposed as an escape hatch for advanced users and as the required parent-step API
  for concurrent combinators.

### Determinism rule

Workflow structure and step names must be stable across replay. Users may branch on prior durable
step results, including tool call results, but must not construct step names from nondeterministic
values such as random IDs, current time, or partial LLM output that was not returned by a completed
step.

### Message flow rule

Agent step APIs should not mutate shared workflow-level message state. Each agent step receives an
explicit `messages` array and returns a new result. Workflow authors combine message arrays
explicitly. This avoids ambiguous behavior when branches run in parallel.

## Data Model Changes

Add the workflow name to Pi sessions so all routes can use the session's actual workflow instead of
hardcoding a built-in workflow name.

```ts
session
  id: idColumn()
  name: string nullable
  agent: string nullable or default agent name for legacy/default sessions
  workflowName: string
  status: string
  createdAt: timestamp
  updatedAt: timestamp
```

Notes:

- `agent` may remain required initially for default chat sessions, but custom workflows may not have
  a single primary agent. If keeping the column required, store the requested default/primary agent
  or an empty sentinel. Prefer making it nullable in a breaking migration.
- `workflowName` must name a registered workflow.

## HTTP API Changes

### Extend `POST /sessions`

```ts
type CreatePiSessionInput = {
  workflow?: string;
  agent?: string;
  name?: string;
  systemMessage?: string;
  input?: unknown;
};
```

Behavior:

1. If `workflow` is omitted, use the built-in default agent loop workflow.
2. For the default workflow, require `agent` and build the current default params shape.
3. For custom workflows, look up the workflow definition and validate `input` against its schema.
4. Always inject `sessionId` into workflow params or context internally.
5. Persist `session.workflowName`.
6. Return the same public session base shape plus `workflowName` if the public schema is updated.

### Existing session routes

All session routes must load `session.workflowName` and use it for workflow service calls:

- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/events`
- `GET /sessions/:sessionId/export/pi-jsonl`
- `POST /sessions/:sessionId/command`

## Session Reconstruction

Current reconstruction assumes command step names like `do:command-0-prompt`. Custom workflows need
a generic projection.

Generic projection rules:

1. Start with workflow initial messages if known.
2. Sort completed workflow steps by `createdAt`, then `stepKey`.
3. For every step result with `type: "agent-run"`, append its persisted non-ephemeral events and
   message delta.
4. Ignore non-agent step results by default.
5. Preserve built-in default cursor state for the default workflow.
6. Add optional workflow-specific projection hooks later if generic projection is insufficient.

## Internal Refactor

### Extract reusable agent-step runner

Move the agent execution logic currently embedded in `createPiAgentLoopWorkflow` into a reusable
helper used by both default and custom workflows.

```ts
type PiAgentStepOperation = {
  mode: PiAgentRunMode;
  input?: PiPromptInput;
};

type PiAgentStepRuntime = {
  event: WorkflowEvent<unknown>;
  step: WorkflowStep;
  stepName: string;
  agent: PiAgentDefinition;
  agentRunner?: PiAgentRunner;
  session: AgentTurnSessionContext;
  turn: AgentTurnContext;
};

type PiAgentStepBehavior = {
  step?: WorkflowStepConfig;
  controls?: Array<"abort" | "steer">;
  stopOnTools?: string[];
  toolExecution?: "sequential" | "parallel";
};

async function runPiAgentStep(
  operation: PiAgentStepOperation,
  runtime: PiAgentStepRuntime,
  behavior?: PiAgentStepBehavior,
): Promise<PiAgentStepResult>;
```

Responsibilities:

- run the agent inside `step.do(stepName, behavior?.step ?? {}, ...)`
- update session status to `active` at step start and `waiting` after completion
- call `runAgentTurn`
- wire live abort/steer control through `tx.onEvent("command", ...)`
- emit agent lifecycle events through `tx.emit(...)`
- filter ephemeral events from persisted step results
- extract `toolCallResults` from `tool_execution_start` and `tool_execution_end` events
- enforce `stopOnTools` termination behavior
- return a stable `PiAgentStepResult`

### Extend `runAgentTurn`

`runAgentTurn` is now a thin adapter around Pi's `Agent`. It accepts three semantic arguments
instead of the workflow payload object:

1. operation: `mode` and optional prompt input
2. runtime: agent definition plus `session` and `turn` context buckets
3. lifecycle: live event/controller callbacks

The workflow input `initialMessages` remains a workflow startup concern and should not be passed to
the runner.

`runAgentTurn` should continue to return Pi-native completion data, especially
`stopReason: StopReason`, instead of a custom `completed`/`errored`/`aborted` outcome enum.

It should also accept and pass through relevant `AgentOptions`:

- `beforeToolCall`
- `afterToolCall`
- `toolExecution`

For `stopOnTools`, Pi can wrap `afterToolCall` and set `terminate: true` for matching tools. If a
step depends on the first decision tool result, use sequential tool execution by default unless the
user explicitly opts into parallel behavior.

## Implementation Checklist

Each item below is intended to be a small vertical slice: it should introduce one user-visible or
internally usable capability, include its tests, and leave the repo in a working state before moving
to the next item.

### Slice 1 — Add inert custom workflow definitions

- [x] Add a new Pi workflow DSL module with `definePiWorkflow(...)` and the minimal
      `PiWorkflowDefinition` type.
- [x] Support `definePiWorkflow({ name, schema, outputSchema }, run)` metadata, but do not wire
      execution yet.
- [x] Export `definePiWorkflow` and its types from `packages/pi-fragment/src/index.ts`.
- [x] Add tests that a definition preserves its name/schemas and that inferred `ctx.params` and
      output types work.
- [x] Verify: `pnpm exec turbo test --filter=./packages/pi-fragment --output-logs=errors-only`.

### Slice 2 — Add typed Pi tool definitions without changing execution

- [x] Add `definePiTool(...)`, `PiToolDefinition`, and typed `resultSchema`/`handoff` metadata.
- [x] Keep the returned value assignable to the existing `PiToolFactory` / `AgentTool` path.
- [x] Export the tool API from `packages/pi-fragment/src/index.ts`.
- [x] Add tests proving existing tools still register and typed tools preserve `details` inference.
- [x] Verify: Pi fragment type-check and tests.

### Slice 3 — Parse tool call events into a pure result model

- [x] Add `PiToolCallResult`, `PiToolCallAccessor`, and a pure helper that converts
      `tool_execution_start`/`tool_execution_end` events into ordered tool call results.
- [x] Capture `toolCallId`, `toolName`, `args`, `result`, `details`, and `isError`.
- [x] Add `first/latest/maybeFirst/maybeLatest/all` accessors with clear errors for missing calls.
- [x] Add tests for no calls, one call, multiple calls to the same tool, multiple tool names, and
      errored calls.
- [x] Verify: Pi fragment type-check and tests.

### Slice 4 — Return enriched agent run results from existing workflow steps

- [x] Extend the existing internal `AgentRunStepResult` to include `toolCallResults` and the
      `toolCalls(...)` accessor helper from Slice 3. Preserve the existing Pi-native `stopReason`
      field.
- [x] Populate `toolCallResults` in the interactive chat workflow without otherwise changing
      workflow behavior.
- [x] Update reconstruction/tests only where necessary to tolerate the additional result field.
- [x] Add a workflow/unit test showing a current agent step result persists tool calls.
- [x] Verify: existing Pi workflow, route, event stream, reconstruction, and JSONL tests still pass.

### Slice 5 — Pass agent tool lifecycle hooks through the runner

- [x] Extend `runAgentTurn(...)` options to accept `beforeToolCall`, `afterToolCall`, and
      `toolExecution`.
- [x] Pass those options to `new Agent(...)` in `agent-runner.ts`.
- [x] Keep `PiAgentDefinition` unchanged unless a test proves definition-level hooks are needed in
      this slice.
- [x] Add a focused test proving a per-run `afterToolCall` can alter a tool result.
- [x] Verify: Pi fragment type-check and tests.

### Slice 6 — Add `stopOnTools` for one existing agent step

- [x] Add `stopOnTools` to the internal agent-step/run options.
- [x] Implement it by wrapping `afterToolCall` and forcing matching tool results to
      `terminate: true`.
- [x] Default `toolExecution` to `sequential` only when `stopOnTools` is provided and no explicit
      `toolExecution` was requested.
- [x] Add a test where an agent calls a decision tool, stops, and exposes the typed tool result.
- [x] Verify: Pi fragment type-check and tests.

### Slice 7 — Extract a reusable `runPiAgentStep(...)` helper with no public behavior change

- [x] Move the current `step.do(... runAgentTurn ...)` body from `workflow.ts` into a reusable
      `runPiAgentStep(...)` helper.
- [x] Keep the interactive chat workflow calling this helper and preserving current step names,
      status updates, live abort/steer handling, event emission, Pi-native stop reasons, and
      recoverable error behavior.
- [x] Ensure the helper returns the enriched `PiAgentStepResult` from Slices 3–6.
- [ ] Add regression tests around the default command loop to prove behavior did not change.
- [x] Verify: full Pi fragment test suite.

### Slice 8 — Compile a custom Pi workflow with context primitives except agents

- [x] Implement conversion from a `PiWorkflowDefinition` to a normal `defineWorkflow(...)` entry.
- [x] Build a minimal `PiWorkflowContext` containing `params`, `sessionId`, `event`, raw `step`,
      `sleep`, `sleepUntil`, and `waitForCommand`.
- [x] Do not add top-level `ctx.emit(...)`; emissions are only available inside individual
      `step.do(...)` callbacks through `tx.emit(...)`.
- [x] Add a low-level test workflow that waits for a command, sleeps, or emits an event from inside
      a named step, and returns output.
- [x] Do not wire `PiBuilder.withWorkflow(...)` yet; instantiate this compiled workflow directly in
      tests.
- [x] Verify: Pi fragment and workflows scenario tests touched by this slice.

### Slice 9 — Add `ctx.agent(...).run/prompt/continue` to custom workflow context

- [x] Add `PiWorkflowAgentHandle` and the `PiWorkflowAgent*Options` types to the context runtime.
- [x] Implement `ctx.agent(name).run(...)` using `runPiAgentStep(...)`.
- [x] Implement `prompt(...)` and `continue(...)` convenience methods.
- [x] Pass agent step `options.step` through as the underlying `WorkflowStepConfig` for retries.
- [x] Add a scenario test for a custom workflow with two sequential agent steps and no user input
      between them.
- [x] Verify: Pi fragment type-check and tests.

### Slice 10 — Prove parallel custom agent steps work

- [x] Add a custom workflow scenario using `Promise.all` with two or more
      `ctx.agent(...).prompt(...)` calls inside a named parent `ctx.step.do(...)`.
- [x] Assert the parent step and each nested child agent step are persisted with stable nested step
      keys.
- [x] Ensure each branch uses explicit `messages` input and returns independent results.
- [x] Assert session reconstruction remains stable for nested parallel agent steps.
- [x] Fix only the smallest runtime issues needed for this scenario.
- [x] Verify: Pi fragment tests plus relevant workflows scenario tests.

### Slice 11 — Prove racing and first-success custom steps work

- [x] Add a custom workflow scenario using `Promise.race` inside a named parent `ctx.step.do(...)`
      between `ctx.waitForCommand(...)` or `ctx.waitForUser(...)` and `ctx.sleep(...)`.
- [x] Add a custom workflow scenario using `Promise.any` inside a named parent `ctx.step.do(...)`
      with two or more durable branches.
- [x] Implement the minimal `ctx.waitForUser(...)` behavior needed for the test: publish a UI prompt
      from inside a named `step.do(...)` with `tx.emit(...)` and wait for a matching durable command
      payload.
- [x] Assert the winning branch determines workflow output and the parent result is replay-safe even
      if losing child steps remain waiting in workflow history.
- [x] Fix only the smallest runtime issues needed for this scenario.
- [x] Verify: Pi fragment tests plus relevant workflows scenario tests.

### Slice 12 — Wire custom workflows into `createPiWorkflows(...)`

- [x] Let `createPiWorkflows(...)` accept custom Pi workflow definitions and compile them into the
      returned workflows registry.
- [x] Keep built-in chat workflow registration explicit rather than included by default.
- [x] Add duplicate workflow-name detection with a clear error.
- [x] Add tests that custom workflows are present in the registry.
- [x] Verify: Pi fragment type-check and tests.

### Slice 13 — Add `.withWorkflow(...)` to `PiBuilder`

- [x] Add `PiBuilder.withWorkflow(definition)` and store definitions on the builder by
      `definition.name`.
- [x] Pass builder workflows into `createPiWorkflows(...)` during `build()`.
- [x] Add a builder test for registering one custom workflow and one typed tool together.
- [x] Verify: Pi fragment type-check and tests.

### Slice 14 — Create custom workflow sessions through the HTTP route

- [x] Extend `POST /sessions` input with required `workflow` and optional `input`.
- [x] Require callers to pass a registered `workflow` name for session creation.
- [x] If `workflow` is provided, validate it exists.
- [x] Validate custom workflow `input` against the workflow schema from Pi session creation.
- [x] Create the selected workflow instance with the generated `sessionId`.
- [x] Add route tests for default session creation, unknown workflow, valid custom workflow
      creation, and nested session creation from a workflow service call.
- [x] Verify: Pi route tests.

### Slice 15 — Store and use `session.workflowName`

- [x] Add `workflowName` to `piSchema.session` and `PiSession`/route schemas.
- [x] Persist `workflowName` when creating both default and custom sessions.
- [x] Update `GET /sessions`, `GET /sessions/:sessionId`, `/events`, `/command`, and JSONL export to
      use the session's workflow name instead of a hardcoded built-in workflow name.
- [x] Add route tests proving a custom session reads status/history/events from its own workflow.
- [x] Verify: Pi route, event stream, and JSONL tests.

### Slice 16 — Make session reconstruction generic for custom workflows

- [x] Update reconstruction to scan completed step results with `type: "agent-run"` instead of
      relying only on `do:command-N-*` step names.
- [x] Preserve default workflow cursor/waiting state behavior for the built-in agent loop.
- [x] Add tests for reconstructing a custom sequential workflow and a custom parallel workflow.
- [x] Include persisted tool call results in the reconstructed/debug state only if required by the
      tests or public schema.
- [x] Verify: reconstruction tests and route detail tests.

### Slice 17 — Rewrite the interactive chat workflow on the public/internal Pi workflow context

- [x] Reimplement `interactive-chat-workflow` using `definePiWorkflow(...)` or the same compiled
      context path used by custom workflows.
- [x] Preserve current command semantics for `prompt`, `continue`, `abort`, `steer`, `followUp`, and
      `complete`.
- [x] Preserve live event streaming, recoverable errors, and `waiting-to-continue` behavior.
- [x] Add regression tests comparing key old step names/results/statuses where compatibility
      matters.
- [x] Verify: full Pi fragment test suite.

### Slice 17B — Normalize Pi session creation around workflow input

- [x] Change `POST /sessions` to accept only `workflow`, optional `name`, and optional `input`.
- [x] Move interactive-chat session fields such as `agentName` and `systemPrompt` under `input`.
- [x] Give the interactive chat workflow an explicit input schema and validate it through the same
      workflow input validation path as custom workflows.
- [x] Remove the special workflow-name casing from the Pi session route; built-in/imported and
      custom workflows should differ only by their workflow definition/schema.
- [x] Keep `services.createSession(...)` focused on persisting the Pi session row; workflow instance
      creation/enqueue remains owned by the workflows service.
- [x] Design and add a small Pi API that combines the paired service calls needed to start a Pi
      workflow session from another workflow, so authors do not have to manually write both:
      `workflows.services.createInstance(...)` and `pi.services.createSession(...)`.
- [x] Ensure the combined API is usable from durable workflow `tx.serviceCalls(...)` without making
      the service factory async.
- [x] Update route tests so built-in and custom session creation both use `{ workflow, input }`.
- [x] Verify: Pi route tests and full Pi fragment tests.

### Slice 18 — Document one working example per capability

- [x] Document a sequential `research → write → approve` workflow.
- [x] Document a `triage by decision tool result → branch to agent` workflow.
- [x] Document a `parallel reviewers → merge` workflow.
- [x] Document deterministic replay, stable step names, explicit message passing, and
      `stopOnTools`/handoff tools.
- [x] Verify examples type-check if they live in executable docs/tests. The examples are README and
      docs-site snippets, so they are non-executable documentation.

### Slice 19 — Final verification

- [x] Run `pnpm exec turbo types:check --filter=./packages/pi-fragment --output-logs=errors-only`.
- [x] Run `pnpm exec turbo test --filter=./packages/pi-fragment --output-logs=errors-only`.
- [x] Run relevant workflows package tests if workflow engine integration changed:
      `pnpm exec turbo test --filter=@fragno-dev/workflows --output-logs=errors-only`.
- [x] Run `pnpm run lint`.

## Locked Decisions

1. Custom Pi workflows are code-first TypeScript workflows, not a separate graph DSL.
2. The Pi workflow API wraps the existing workflows engine and should not hide `Promise.all`,
   `Promise.race`, `Promise.any`, or durable step semantics; concurrent combinators must be wrapped
   in named parent steps.
3. Tool calls are first-class step results for custom workflows.
4. Workflow branching based on tool results is a primary supported use case.
5. Decision/handoff tools are explicit via `handoff` metadata and/or per-step `stopOnTools`.
6. The default hardcoded agent loop becomes a built-in workflow implemented through the same
   primitives as user-defined workflows.
7. Session routes must stop assuming every session uses a built-in workflow.
8. Step names must be stable and deterministic.
9. There is no top-level `ctx.emit(...)`; emissions can only happen inside named workflow steps via
   `tx.emit(...)`.
