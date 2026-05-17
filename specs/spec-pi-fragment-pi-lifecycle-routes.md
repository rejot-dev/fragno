# Pi Fragment Pi Lifecycle Routes — Plan

## Open Questions

None.

## 1. Overview

Rework `@fragno-dev/pi-fragment` so the public routes and workflow internals align with Pi's own
runtime shape instead of pi-fragment's current turn/trace/command-history projection.

The core simplification is:

> To resume an agent after durable workflow replay, pi-fragment only needs the agent definition
> system prompt/config and the `AgentMessage[]` transcript so far.

Everything else is either:

- a UI/read-model convenience (`AgentEvent[]`), or
- workflow-private waiting/control state.

This means we should delete most of the current route/detail complexity. The main read model should
be Pi-shaped:

- `agent.state.messages`
- `agent.events`
- live `AgentEvent` streaming

The public API keeps the existing single command submission route for now:

- `POST /sessions/:sessionId/command`

## 2. References

Checked against the local Pi source referenced by the user:

- Agent event contract: `/Users/wilco/dev/pi-mono/packages/agent/src/types.ts`
- Agent event sequence docs: `/Users/wilco/dev/pi-mono/packages/agent/README.md`
- Coding agent persistence:
  `/Users/wilco/dev/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- Session file entries: `/Users/wilco/dev/pi-mono/packages/coding-agent/src/core/session-manager.ts`

Pi's core public lifecycle is the `AgentEvent` stream. Pi's durable/resume context is the message
transcript plus runtime config. pi-fragment should follow that model instead of inventing a separate
turn summary and command-history read model.

## 3. Locked Simplifications

1. Keep `POST /sessions/:sessionId/command` as the single command submission route.
2. Remove the old public detail concepts: `trace`, `turns`, `commandHistory`, top-level `phase`,
   top-level `turn`, and top-level `waitingFor`.
3. Remove public operation records unless a later UI explicitly needs them.
4. Persist complete `AgentEvent[]` arrays in workflow operation step results for the read model.
5. Persist `AgentMessage[]` in each successful agent operation step result as the resume source of
   truth.
6. Treat workflow wait state, command index, turn number, allowed command calculation, and live
   controllers as workflow-private implementation details.
7. Do not expose workflow step keys, operation indexes, rejection records, or consumed command rows
   through `GET /sessions/:sessionId`.
8. Commands can still be rejected internally, but the public model is simple: command route returns
   accepted delivery; session detail shows current agent state/events.
9. Zod route schemas should use `z.custom<AgentMessage>()` and `z.custom<AgentEvent>()` for Pi types
   so declaration-merged custom messages remain representable.

## 4. Minimal Public Route Shape

### 4.1 Existing Routes Kept

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/export/pi-jsonl`
- `POST /sessions/:sessionId/command`

### 4.2 New Event Stream Route

```http
GET /sessions/:sessionId/events
Accept: application/x-ndjson
```

Stream items should be as close to Pi as possible. Avoid the current `layer: "system" | "pi"`
protocol.

```ts
type PiSessionEventStreamItem =
  | {
      type: "snapshot";
      state: PiAgentStateSnapshot;
    }
  | AgentEvent
  | {
      type: "settled";
      state: PiAgentStateSnapshot;
    }
  | {
      type: "inactive";
      reason: "session-complete" | "session-idle";
      state: PiAgentStateSnapshot;
    };
```

Notes:

- `AgentEvent` values are streamed unchanged.
- The `snapshot`, `settled`, and `inactive` items are the only fragment-owned stream control items.
- Replay after restore comes from persisted workflow step result `events` arrays.
- While an operation is live, the stream emits in-memory events immediately before that workflow
  step commits.

## 5. Minimal `GET /sessions/:sessionId` Shape

Replace `sessionDetailSchema` with a Pi-shaped session detail.

```ts
type PiAgentStateSnapshot = {
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
};

type PiSessionDetail = PiSession & {
  workflow: PiSessionWorkflowStatus;
  agent: {
    state: PiAgentStateSnapshot;
    events: AgentEvent[];
  };
};
```

Schema implementation notes:

```ts
const agentMessageSchema: z.ZodType<AgentMessage> = z.custom<AgentMessage>();
const agentEventSchema: z.ZodType<AgentEvent> = z.custom<AgentEvent>();

const piAgentStateSnapshotSchema = z.object({
  messages: z.array(agentMessageSchema),
  isStreaming: z.boolean(),
  streamingMessage: agentMessageSchema.optional(),
  errorMessage: z.string().optional(),
});

const sessionDetailSchema = sessionBaseSchema.extend({
  workflow: workflowStatusSchema,
  agent: z.object({
    state: piAgentStateSnapshotSchema,
    events: z.array(agentEventSchema),
  }),
});
```

No `operations`, no `control`, no `turns`, no `commandHistory`.

If a client needs to know whether input is likely allowed, it can derive a basic UI state from:

- `session.status`
- `session.agent.state.isStreaming`
- `session.agent.state.errorMessage`
- `workflow.status`

The command route remains the source of truth for whether a command is accepted for delivery, and
the workflow remains the source of truth for whether a delivered command actually changes the agent
state.

## 6. Workflow Internals: Simplified Step Results

The current `CommandStepResult` is complex because it tries to preserve pi-fragment's custom turn
and operation read model. If the public model is Pi state + Pi events, it can be reduced heavily.

Target agent operation result:

```ts
type PiAgentRunResult = {
  outcome: "completed" | "errored" | "aborted";
  messages: AgentMessage[];
  events: AgentEvent[];
  errorMessage: string | null;
  toolJournal: PiPersistedToolCall[];
};
```

Target workflow command step result:

```ts
type CommandStepResult =
  | {
      type: "agent-run";
      outcome: "completed" | "errored" | "aborted";
      messages: AgentMessage[];
      events: AgentEvent[];
      errorMessage: string | null;
      toolJournal?: unknown;
    }
  | {
      type: "noop";
      reason?: string;
    }
  | {
      type: "complete";
    };
```

What disappears from durable step results:

- `commandId`
- `commandStatus`
- `rejectionReason`
- `turn`
- `operationIndex`
- `stepKey`
- `commandCreatedAt`
- `consumedAt`
- `operationCreatedAt`
- `operationCompletedAt`
- `assistant`
- `liveInjection`
- `trace`
- `durableEvents`

Why this is enough:

- The next agent run only needs `messages` plus agent config/system prompt.
- Public detail only needs flattened `messages` and `events`.
- Workflow internals already know the step name/key while executing; they do not need to echo it
  into the step result for public routes.
- Command IDs are useful for the immediate HTTP ACK but do not need to become part of the read
  model.
- Rejected/no-op commands do not need public history if we are intentionally reducing API surface.

## 7. Workflow Loop State

Keep workflow-private state small and operational only:

```ts
type PiAgentLoopPhase = "waiting-for-command" | "running-agent" | "complete";

type PiAgentLoopPersistedState = {
  phase: PiAgentLoopPhase;
  activeSessionUpdatesByTurn: PiActiveSessionReplayBuffer;
};
```

The workflow can still keep local variables while replaying completed steps:

```ts
type TurnExecutionContext = {
  messages: AgentMessage[];
  events: AgentEvent[];
};
```

On each completed `agent-run` step:

```ts
context.messages = result.messages;
context.events.push(...result.events);
hydrateReplayCache(replayCache, result.toolJournal);
```

`turn`, `commandIndex`, and stable step names may still exist internally if required for
`waitForEvent` names, but they should not leak into route schemas.

## 8. Active Session State

Simplify `PiActiveSessionState` to buffer raw Pi events.

```ts
type PiActiveSessionUpdate =
  | { type: "event"; event: AgentEvent }
  | { type: "settled"; state: PiAgentStateSnapshot };
```

Rules:

- Publish every `AgentEvent` to live subscribers immediately.
- Keep an in-memory replay buffer for reconnects during the same live operation.
- Persist the operation's full `events` array in the workflow step result when the step completes.
- Restore/replay after restart reads committed `events` arrays from workflow step results.

## 9. Reconstructing Session Detail

Replace `projectSessionDetailFromWorkflowHistory()` with a much smaller projection:

1. Parse workflow step results.
2. Flatten every `agent-run.events` array into `agent.events`.
3. Use the latest `agent-run.messages` array as `agent.state.messages`.
4. If no latest messages array exists, derive messages from `message_end` events.
5. Overlay live state if there is a current live workflow instance:
   - `isStreaming`
   - `streamingMessage`
   - additional not-yet-committed live events
6. Return `PiSessionDetail`.

No command-history reconstruction. No turn reconstruction. No operation summaries.

## 10. Command Route

Keep the public command route exactly as one route:

```http
POST /sessions/:sessionId/command
```

The input schema can stay discriminated for now:

```ts
type PiSessionCommandPayload =
  | { kind: "prompt"; input: PiPromptInput }
  | { kind: "continue" }
  | { kind: "abort"; reason?: string }
  | { kind: "steer"; input: PiPromptInput }
  | { kind: "followUp"; input: PiPromptInput }
  | { kind: "complete"; reason?: string };
```

ACK stays simple:

```ts
type PiCommandAck = {
  accepted: true;
  commandId: string;
  status: PiSessionStatus;
};
```

Internally, the generated `commandId` is only for correlation/logging/live-injection. It does not
need to appear in `GET /sessions/:sessionId`.

## 11. Client Store Updates

Public store state target:

```ts
type PiSessionStoreState = {
  loading: boolean;
  session: PiSessionDetail | null;
  messages: AgentMessage[];
  events: AgentEvent[];
  runningTools: PiLiveToolExecution[];
  connection: PiSessionConnectionState;
  statusText: string | null;
  readyForInput: boolean;
  sending: boolean;
  error: string | null;
  sendError: string | null;
};
```

Behavior:

- Snapshot messages come from `session.agent.state.messages`.
- Snapshot events come from `session.agent.events`.
- Live `/events` frames append raw `AgentEvent` values.
- `message_update` maintains draft assistant state.
- `message_end` appends/replaces finalized messages.
- `tool_execution_start/update/end` affect live running tool UI.
- `readyForInput` is best-effort UI state derived from `session.status`, `workflow.status`,
  `agent.state.isStreaming`, and local pending send state.

Rename `traceEvents` to `events` in the controller view.

## 12. CLI Updates

Keep CLI command submission through `POST /sessions/:sessionId/command`.

Update detail rendering terms:

- `Trace` becomes `Events`.
- `Turns` is removed.
- `Command History` / `Operations` is removed from default detail output.
- Status-only output includes `workflow` and a compact `agent.state` summary.

## 13. Documentation Updates

Update `packages/pi-fragment/README.md`:

- Document `GET /sessions/:sessionId/events`.
- Explain that `GET /sessions/:sessionId` returns Pi state + persisted Pi lifecycle events.
- Explain that durable resume depends on agent config/system prompt + `AgentMessage[]`.
- Keep documenting `POST /sessions/:sessionId/command` as the single command route.

Update backoffice/session docs that mention `trace`, `turns`, `operations`, `commandHistory`, or
`/active`.

## 14. Test Plan

Route tests:

- Creating a session returns detail with `agent.state.messages = []` and `agent.events = []`.
- Prompt command persists the complete Pi lifecycle, including `agent_start`, `turn_start`,
  `message_start`, `message_update`, `message_end`, `turn_end`, and `agent_end`.
- Detail output does not include old `trace`, `turns`, `commandHistory`, `operations`, top-level
  `phase`, top-level `turn`, or top-level `waitingFor`.
- Tool execution persists the full tool lifecycle in detail: `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, plus the finalized `toolResult` `message_end`.
- `/events` stream emits raw `AgentEvent` items while live.
- `/events` replay after restore includes persisted lifecycle events from workflow step results.
- The existing `POST /sessions/:sessionId/command` tests continue to pass with updated detail
  assertions.

Client tests:

- Live draft assistant is built from `message_update` frames.
- Running tool UI is built from `tool_execution_start/update/end` frames.
- Final messages reconcile from `message_end` frames and then snapshot refetch.
- `traceEvents` consumers are updated to `events`.

CLI tests:

- `sessions get --status-only --json` returns `workflow` and `agent.state` summary.
- Full detail text renders Messages and Events.
- Prompt command still POSTs to `/sessions/:sessionId/command`.

## 15. Implementation Tasks

- [x] Replace route schemas in `packages/pi-fragment/src/pi/route-schemas.ts` with minimal Pi-shaped
      `AgentMessage` / `AgentEvent` custom schemas and the simplified session detail schema.
- [x] Update `packages/pi-fragment/src/pi/types.ts` to remove public `trace`, `turns`,
      `commandHistory`, `operations`, and public control detail types.
- [x] Update `packages/pi-fragment/src/pi/workflow/agent-runner.ts` so it returns
      `{ outcome, messages, events, errorMessage, toolJournal }`.
- [x] Simplify `CommandStepResult` in `packages/pi-fragment/src/pi/workflow/workflow.ts` to
      `agent-run | noop | complete`.
- [x] Keep workflow phase/wait state private to `workflow.ts`; stop projecting it through routes.
- [x] Simplify active session buffering to raw `AgentEvent` updates plus settled snapshots.
- [x] Rewrite `packages/pi-fragment/src/pi/workflow/reconstruct-session.ts` to flatten step result
      events and take latest messages.
- [x] Update `packages/pi-fragment/src/routes.ts` detail handler and add
      `GET /sessions/:sessionId/events`.
- [x] Update `packages/pi-fragment/src/client/session-store.ts` and
      `packages/pi-fragment/src/client/session-controller.ts` for new detail and stream shapes.
- [x] Update CLI render/actions/tests for `agent.state` and `events` terminology.
- [x] Update README/docs and in-repo callers.
- [x] Replace route/client/workflow tests for the simplified Pi-shaped lifecycle model.
- [x] Run `pnpm exec turbo types:check --filter=@fragno-dev/pi-fragment --output-logs=errors-only`.
- [x] Run `pnpm exec turbo test --filter=@fragno-dev/pi-fragment --output-logs=errors-only`.
- [x] Run `pnpm exec turbo build --filter=@fragno-dev/pi-fragment --output-logs=errors-only`.
