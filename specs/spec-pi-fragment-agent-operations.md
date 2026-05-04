# Pi Fragment Agent Operations + Durable Turn Control — Spec

## Open Questions

None.

## 1. Overview

This document specifies a **breaking redesign** of `@fragno-dev/pi-fragment` around explicit,
first-class agent operations:

- `prompt`
- `continue`
- `abort`
- `steer`
- `followUp`
- `complete` (session-level, not an `Agent` method)

The current pi session workflow is built around a chat-style `POST /sessions/:sessionId/messages`
route and an internal loop that always appends a user message and then calls `agent.continue()`.
That shape is too narrow for multi-step orchestration, does not map clearly onto the workflows
fragment’s durable step model, and does not expose the broader control concepts that pi itself
supports (`steer`, `followUp`).

The new design makes the pi workflow a **command-driven session orchestrator**. Every externally
observable action becomes an explicit workflow step with a stable, human-readable name so operators
can see exactly what happened for each turn:

- wait for a session command
- run `prompt`
- run `continue`
- record `abort`
- run `steer`
- run `followUp`
- optionally `complete` the session

This redesign is intentionally **forward-only and fully breaking**. We will remove the old
message-centric API and update all in-repo callers forward in the same change set.

## 2. References

- `@mariozechner/pi-agent-core` docs:
  `node_modules/.pnpm/@mariozechner+pi-agent-core@0.67.68_ws@8.18.3_zod@4.3.5/node_modules/@mariozechner/pi-agent-core/README.md`
- `@mariozechner/pi-agent-core` implementation:
  `node_modules/.pnpm/@mariozechner+pi-agent-core@0.67.68_ws@8.18.3_zod@4.3.5/node_modules/@mariozechner/pi-agent-core/dist/agent.js`
- Current pi workflow loop: `packages/pi-fragment/src/pi/workflow/workflow.ts`
- Current pi agent runner: `packages/pi-fragment/src/pi/workflow/agent-runner.ts`
- Current pi types: `packages/pi-fragment/src/pi/types.ts`
- Current pi routes and schemas: `packages/pi-fragment/src/routes.ts`,
  `packages/pi-fragment/src/pi/route-schemas.ts`
- Active session replay/live state: `packages/pi-fragment/src/pi/workflow/active-session.ts`
- Workflows step semantics and naming: `packages/fragment-workflows/src/runner/step.ts`
- Workflows instance lifecycle/services: `packages/fragment-workflows/src/definition.ts`

## 3. Terminology

- **Session**: The long-lived pi conversation/runtime instance owned by the pi fragment.
- **Turn**: A unit of agent work that starts with `prompt`, may include same-turn control operations
  such as `continue`, `abort`, and `steer`, and may be followed by a next-turn `followUp` command
  once current work settles.
- **Command**: A durable session instruction sent to the workflow (`prompt`, `continue`, `abort`,
  `steer`, `followUp`, `complete`).
- **Command ID**: A stable identifier generated at command submission time and returned to the
  caller. It lets clients correlate delivery (`202`) with later command application or rejection.
- **Operation**: The execution of a single command inside the workflow. Every operation maps to one
  durable workflow step.
- **Durable truth**: The command events and durable step results persisted by the workflows
  fragment. Any user-visible session state must be reconstructable from this history.
- **Recoverable failure**: An agent run outcome that should keep the workflow alive and allow a
  later `continue` or `abort` instead of marking the whole workflow instance errored.
- **Live controller**: Ephemeral in-memory handle for the currently running agent operation,
  allowing durably persisted control commands to also affect the live `Agent` immediately.
- **Live injection**: Best-effort immediate application of a durably accepted control command to the
  currently running in-memory `Agent` before the workflow later consumes and records that same
  command durably.

## 4. Goals / Non-goals

### 4.1 Goals

1. Support first-class `prompt`, `continue`, `abort`, `steer`, and `followUp` semantics in
   pi-fragment.
2. Make durable workflow history easy to understand at a glance for every turn.
3. Keep the pi workflow alive across recoverable agent errors and aborted runs.
4. Allow other workflows/fragments to orchestrate pi sessions without pretending every action is a
   user text message.
5. Preserve live trace/event streaming and replay behavior.
6. Make abort durable **and** responsive by combining persisted command delivery with live in-memory
   interruption.
7. Ensure user-visible session state is reconstructable from durable command events and step
   results, not from in-memory-only workflow state.
8. Update all in-repo callers forward in the same branch with no compatibility shim period.

### 4.2 Non-goals

1. Backward compatibility with `POST /sessions/:sessionId/messages`.
2. Supporting arbitrary custom `AgentMessage` declaration-merging message types over the public HTTP
   API.
3. Preserving the current `summaries` and `events` route shapes exactly.
4. Exposing workflows fragment history directly through the pi HTTP API in this change.
5. Preserving every in-memory queue nuance from pi (for example exact steering/follow-up queue drain
   modes) when that would add awkward workflow-engine-specific complexity.
6. Guaranteeing restart-safe interruption or restart-safe live queue injection for an
   already-running in-memory agent operation in this redesign.

## 5. Locked breaking decisions

1. The old `POST /sessions/:sessionId/messages` route is removed.
2. Session control becomes command-based and explicit.
3. The session workflow phase `waiting-for-user` is renamed to `waiting-for-command`.
4. `done` is removed from session input. Session completion becomes explicit via `complete`.
5. Agent operation failures (`error`, `aborted`) stop being automatic workflow-terminal failures.
   They become structured operation outcomes unless an internal invariant fails.
6. Session detail schemas may change shape freely where needed (`events`, `summaries`, `waitingFor`,
   action availability, command history).
7. All internal clients, CLI code, tests, and docs are fixed forward in the same implementation.
8. `steer` and `followUp` become first-class session commands.
9. `steer`, `followUp`, and `abort` use a hybrid model: commands are durably accepted first and,
   when a live controller exists, are also injected into the current in-memory `Agent` immediately.
10. Live control injection is **best effort while the current process is alive**. This redesign does
    not guarantee restart-safe interruption or restart-safe queue injection for an already-running
    agent step.
11. We preserve the pi concepts of steering and follow-up, but we do **not** promise exact parity
    with all of pi's in-memory queue-draining behaviors when those do not map naturally to the
    workflow engine.
12. Durable command events plus durable step results are the source of truth; workflow state is a
    reconstructed projection and live in-memory state is only for live conveniences.

## 6. Current problems to solve

### 6.1 `prompt` is not modeled directly

Today pi-fragment persists a user message in a workflow step and then always constructs a new
`Agent` and calls `agent.continue()`. This hides the `prompt()` boundary, so there is no durable
step that says “the agent was prompted here”.

### 6.2 `continue` is not a first-class workflow action

The current design uses `continue()` internally for every run, but it does not expose a durable,
user-visible `continue` concept. That makes multi-step orchestration awkward.

### 6.3 `abort` is not supported

`Agent.abort()` only affects a currently running in-memory agent. The current pi workflow has no
explicit abort route/service, no persisted abort intent, and no live abort controller.

### 6.4 Workflow history is chat-shaped, not operation-shaped

Current durable step names (`user-N`, `assistant-N`, `wait-user-N`) do not reveal whether a turn was
prompted, continued, retried, aborted, steered, or scheduled via follow-up.

## 7. Target architecture

### 7.1 Session command model

The pi workflow becomes a command loop. Commands are persisted using
`workflowsService.sendEvent(...)` with a single workflow event type, `"command"`, and are consumed
in FIFO order.

```ts
type PiSessionCommandId = string;

type PiSessionCommandType = "prompt" | "continue" | "abort" | "steer" | "followUp" | "complete";

type PiPromptInput = {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

type PiSessionCommandPayload =
  | {
      commandId: PiSessionCommandId;
      kind: "prompt";
      input: PiPromptInput;
    }
  | {
      commandId: PiSessionCommandId;
      kind: "continue";
    }
  | {
      commandId: PiSessionCommandId;
      kind: "abort";
      reason?: string;
    }
  | {
      commandId: PiSessionCommandId;
      kind: "steer";
      input: PiPromptInput;
    }
  | {
      commandId: PiSessionCommandId;
      kind: "followUp";
      input: PiPromptInput;
    }
  | {
      commandId: PiSessionCommandId;
      kind: "complete";
      reason?: string;
    };

type PiSessionCommandEvent = {
  type: "command";
  payload: PiSessionCommandPayload;
};
```

Locked transport semantics:

- We keep using workflow events as the durable command transport; no separate pi-owned command table
  is introduced.
- There is only one public workflow event type for session control: `"command"`.
- The workflow step API only yields one pending matching event at a time, so pi-fragment treats
  command delivery as a single FIFO queue.
- Commands are **not** strictly state-gated at submission time. They are durably accepted first and
  then validated when consumed by the workflow.
- Public session state must be reconstructable from these command events plus durable `do:*` step
  results.

Notes:

- Public prompt, steer, and follow-up input is intentionally limited to user text + optional images.
- Every public route/service generates a `commandId` server-side before calling `sendEvent(...)` and
  returns it in the `202` ack.
- `abort`, `steer`, and `followUp` use hybrid semantics: durable acceptance first, plus immediate
  live injection when a matching in-memory controller is currently registered.
- That live injection is best effort for the lifetime of the current process only. If the process
  restarts while an agent step is already running, this redesign does not guarantee that an already
  accepted control command will interrupt or inject into that in-flight operation.
- The internal runner may still construct richer `AgentMessage[]` when needed.
- The session keeps its existing session-level `steeringMode`; each new `Agent` instance applies
  that persisted setting.
- This redesign does **not** add public `followUpMode` configuration. The runner uses
  pi-agent-core's default follow-up mode unless a later spec extends it.
- `complete` is a session lifecycle command, not an `Agent` method.
- We preserve the pi concepts of `steer` and `followUp`, but we intentionally do not spec exact
  parity with pi queue-draining mode details unless they fall out naturally from the workflow model.

### 7.2 Session state model

Replace the user-message-centric loop state with command-oriented state.

```ts
type PiAgentLoopPhase = "waiting-for-command" | "running-agent" | "complete";

type PiTurnStatus = "idle" | "running" | "waiting-to-continue" | "aborted" | "completed";

type PiTurnOperationKind = "prompt" | "continue" | "abort" | "steer" | "followUp";

type PiTurnOperationOutcome = "completed" | "errored" | "aborted";

type PiTurnOperationRecord = {
  commandId: PiSessionCommandId;
  turn: number;
  operationIndex: number;
  kind: PiTurnOperationKind;
  stepKey: string;
  outcome: PiTurnOperationOutcome;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

type PiTurnSummary = {
  turn: number;
  status: PiTurnStatus;
  assistant: AgentMessage | null;
  summary: string | null;
  operations: PiTurnOperationRecord[];
};

type PiSessionCommandRecord = {
  commandId: PiSessionCommandId;
  kind: PiSessionCommandType;
  turn: number | null;
  stepKey: string | null;
  commandStatus: "accepted" | "applied" | "rejected";
  rejectionReason: string | null;
  createdAt: Date;
  consumedAt: Date | null;
};

type PiAgentLoopWaitingFor =
  | {
      type: "command";
      turn: number;
      stepKey: string;
      allowedCommands: PiSessionCommandType[];
      timeoutMs: number | null;
    }
  | {
      type: "agent";
      turn: number;
      operation: "prompt" | "continue";
      stepKey: string;
    }
  | null;
```

Locked behavior:

- A fresh session starts in `waiting-for-command` with
  `allowedCommands: ["prompt", "followUp", "complete"]`.
- After a recoverable agent error, the session waits with `allowedCommands: ["continue", "abort"]`.
- After a successful `prompt`/`continue`, the session advances to the next turn and waits for
  `prompt`, `followUp`, or `complete`.
- After `abort`, the current turn closes as aborted and the next state is fresh prompt waiting.
- `allowedCommands` is an observational/UI hint about what would apply **if consumed now**. It is
  not a strict submission gate because command delivery still happens via queued workflow events.
- `assistant` on `PiTurnSummary` is the final successful assistant message for that turn. It is
  `null` for turns that never produced a successful assistant message (for example abort-only or
  error-only turns).
- `summary` is derived from that final successful assistant message and is `null` when `assistant`
  is `null`.

### 7.3 Workflow-visible step naming

Every consumed command must map to an obvious workflow step key. Rejected commands still produce a
`do:*` step so the implementation and workflow history stay uniform.

Required naming contract:

- wait for next command: `wait-command-turn-${turn}-command-${commandIndex}`
- execute prompt: `prompt-turn-${turn}-op-${operationIndex}`
- execute continue: `continue-turn-${turn}-op-${operationIndex}`
- record abort: `abort-turn-${turn}-op-${operationIndex}`
- execute steer: `steer-turn-${turn}-op-${operationIndex}`
- execute follow-up: `follow-up-turn-${turn}-op-${operationIndex}`
- complete session: `complete-session-command-${commandIndex}`

Examples as stored by the workflows engine:

- `waitForEvent:wait-command-turn-0-command-0`
- `do:prompt-turn-0-op-0`
- `waitForEvent:wait-command-turn-0-command-1`
- `do:steer-turn-0-op-1`
- `do:continue-turn-0-op-2`
- `do:follow-up-turn-1-op-0`
- `do:complete-session-command-4`

This naming is part of the spec and must remain stable.

## 8. Agent runner redesign

### 8.1 Explicit operation mode

Replace the current “always continue” runner with explicit operation modes.

```ts
type PiAgentRunMode = "prompt" | "continue";

type PiAgentRunResult = {
  mode: PiAgentRunMode;
  outcome: "completed" | "errored" | "aborted";
  messages: AgentMessage[];
  trace: AgentEvent[];
  assistant: AgentMessage | null;
  errorMessage: string | null;
  toolJournal: PiPersistedToolCall[];
};
```

`runAgentTurn(...)` becomes something like:

```ts
runAgentTurn({
  mode: "prompt" | "continue",
  promptInput?: PiPromptInput,
  ...
}): Promise<PiAgentRunResult>
```

### 8.2 `prompt` semantics

For `mode: "prompt"` the runner must call `agent.prompt(...)` with an explicit user message built
from the command payload.

### 8.3 `continue` semantics

For `mode: "continue"` the runner must call `agent.continue()`, but first it must normalize the
persisted transcript so a prior synthetic assistant failure message does not block continuation.

Locked rule:

- If the final persisted message is an assistant message with `stopReason` of `"error"` or
  `"aborted"` and a non-empty `errorMessage`, that trailing failure message is removed from the
  transcript snapshot used for `agent.continue()`.
- The persisted transcript itself remains unchanged until the next operation result is written.

### 8.4 Recoverable outcomes vs workflow-terminal failures

The runner must stop throwing for normal agent outcomes.

- `completed` → return structured success.
- `errored` → return structured recoverable failure with `errorMessage`.
- `aborted` → return structured abort outcome.
- Only invalid preconditions, transcript corruption, tool journal corruption, or other internal
  invariants may throw and fail the workflow step itself.

### 8.5 Tool replay behavior

The current persisted tool replay journal remains in place. The redesign must preserve replay
semantics for retried durable workflow steps.

## 9. Workflow execution model

### 9.1 Command loop

The workflow implementation in `packages/pi-fragment/src/pi/workflow/workflow.ts` is rewritten as:

1. wait for the next `"command"` event
2. consume exactly one queued command in FIFO order
3. execute the durable `do:*` step for that command
4. inside that step, validate whether the command applies to the current state
5. record a structured command result keyed by `commandId` (`applied` or `rejected`)
6. update the reconstructed loop projection, turn summaries, replay cache, and active-session state
   when the command was applied
7. continue waiting for the next command unless the session has completed

Important consequences of this model:

- Route/service submission is durable command delivery, not guaranteed application.
- Rejected commands are expected and are represented as completed `do:*` steps with a structured
  result.
- Commands behind an applied `abort` remain in the queue and are consumed normally afterwards. They
  may then apply or be rejected based on the new state.
- Live injection into a currently running agent is best effort only and is not guaranteed to survive
  process restart.
- The projected session state exposed by pi-fragment must be fully reconstructable from command
  events plus durable step results; live in-memory state is never the only source of user-visible
  truth.

### 9.2 Command handling rules

#### `prompt`

A consumed `prompt` command is **applied** only when the session is waiting for a fresh turn.
Otherwise its `do:prompt-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- append a new user message to the transcript
- run `agent.prompt(...)`
- append a new operation record
- if outcome is `completed`, close the turn and advance to the next turn
- if outcome is `errored`, keep the same turn open in `waiting-to-continue`
- if outcome is `aborted`, keep the same turn open until a later consumed `abort` command closes it

#### `continue`

A consumed `continue` command is **applied** only when the current turn is in `waiting-to-continue`.
Otherwise its `do:continue-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- run `agent.continue()`
- append a new operation record
- if outcome is `completed`, close the turn and advance to the next turn
- if outcome is `errored`, remain in `waiting-to-continue`
- if outcome is `aborted`, remain on the same turn until a later consumed `abort` command closes it

#### `abort`

A consumed `abort` command is **applied** only when either:

- the session is currently `running-agent`, or
- the current turn is in `waiting-to-continue`

Otherwise its `do:abort-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- after durable command acceptance, if a live controller exists for the running operation, it is
  invoked immediately
- the workflow later consumes the abort command and records an explicit `abort` durable step
- the durable step records whether live injection was attempted and whether a live controller was
  present
- the current turn is closed with status `aborted`
- the session advances to the next fresh-turn waiting state
- queued commands behind the abort are **not flushed**; they are consumed later in FIFO order

#### `steer`

A consumed `steer` command is **applied** only when there is an open running agent operation for
that turn or when the workflow can prove the steering command was already live-injected into that
same running turn. Otherwise its `do:steer-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- after durable command acceptance, if a live controller exists for the running operation, the
  controller immediately calls `agent.steer(...)` with a user message built from the command input
- it stays attached to the current turn rather than creating a new turn
- when the workflow later consumes the command, the durable step records whether live injection was
  attempted, whether it succeeded, and which turn it targeted
- if no live controller existed and no prior live injection was recorded for the command, the
  command is rejected rather than being silently converted into a next-turn prompt
- pi-fragment preserves the steering concept but does not promise exact parity with every pi
  queue-draining nuance if that would add awkward workflow-engine complexity

#### `followUp`

A consumed `followUp` command is **applied** when either:

- it was durably accepted and live-injected into a currently running agent's follow-up queue, or
- the session is idle in a fresh-turn waiting state and the command can become the next turn's
  starting user message directly

Otherwise its `do:follow-up-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- after durable command acceptance, if a live controller exists for the running operation, the
  controller immediately calls `agent.followUp(...)` with a user message built from the command
  input
- when live-injected during a running turn, it remains conceptually attached to that running turn's
  completion path and becomes the next turn's starting user message only after current work settles
- when already idle in a fresh-turn waiting state, it may apply immediately as the next turn starter
  without any live injection
- when the workflow later consumes the command, the durable step records whether live injection was
  attempted, whether it succeeded, and which turn it targeted
- if neither live injection nor idle next-turn scheduling was possible, the command is rejected

#### `complete`

A consumed `complete` command is **applied** only when the session is in the fresh prompt waiting
state. Otherwise its `do:complete-session-command-*` step completes with
`{ commandStatus: "rejected", rejectionReason: ... }`.

Effects when applied:

- no agent run occurs
- the session moves to phase `complete`
- active-session streaming settles the current turn as `complete`

### 9.3 Workflow step status conventions

Expected command outcomes (`errored`, `aborted`) and command rejections must not mark the workflows
step itself as `errored` unless a true invariant/infrastructure failure occurred.

Therefore:

- every consumed command gets a corresponding `do:*` step
- normal command handling steps end in workflows status `completed`
- the step result payload carries `commandId`
- the step result payload carries `commandStatus: "applied" | "rejected"`
- rejected command results carry `rejectionReason`
- for applied `prompt` / `continue` commands, the result also carries the agent operation outcome
  plus the resulting turn / operation coordinates used by the session projection
- only internal failures should make the workflows step itself `errored`

This keeps workflow history readable and avoids conflating “the agent errored” or “the command was
stale” with “the workflow engine broke”.

## 10. Live state and abort control

### 10.1 Active session state extensions

Extend `PiActiveSessionState` with ephemeral live operation control.

```ts
type PiLiveOperationController = {
  turn: number;
  operation: "prompt" | "continue";
  stepKey: string;
  abort(): void;
  steer(input: PiPromptInput): void;
  followUp(input: PiPromptInput): void;
};
```

Required capabilities:

- register the currently running live controller
- clear it when the operation settles
- expose the current live controller for abort / steer / follow-up routes and services
- track best-effort live injection metadata per `commandId` so the later durable `do:*` step can
  record whether immediate live injection was attempted and whether a controller was present
- keep replay buffer behavior unchanged for persisted event replay

The live controller and its injection bookkeeping are **not persisted**; they are live execution
conveniences layered on top of durable command delivery. After process restart, previously accepted
control commands still exist durably in workflow history, but this redesign does not guarantee
mid-step live interruption/injection of the pre-restart in-flight agent run.

### 10.2 Active session protocol updates

The active session stream remains, but the snapshot/system messages must report command-oriented
state:

- `phase: "waiting-for-command" | "running-agent" | "complete"`
- `waitingFor.allowedCommands` when waiting for a command
- current `stepKey` / operation when running

The protocol may change shape freely as part of this breaking redesign.

## 11. HTTP API and service surface

### 11.1 Remove

- `POST /sessions/:sessionId/messages`

### 11.2 Add routes

```txt
POST /sessions/:sessionId/command
```

### 11.3 Route contract

#### `POST /sessions/:sessionId/command`

Input:

```ts
type PiSessionCommandInput =
  | {
      kind: "prompt";
      input: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };
    }
  | { kind: "continue" }
  | { kind: "abort"; reason?: string }
  | {
      kind: "steer";
      input: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };
    }
  | {
      kind: "followUp";
      input: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };
    }
  | { kind: "complete"; reason?: string };
```

The route returns `202` with a command-acceptance ack:

```ts
type PiSessionCommandAcceptedResponse = {
  accepted: true;
  commandId: PiSessionCommandId;
  status: PiSessionStatus;
};
```

Routes do not accept client-supplied `commandId` values in this redesign.

### 11.4 Service surface

This iteration keeps command submission on the HTTP route surface only. Fragment service methods can
be added later once live-control semantics are defined for non-HTTP callers.

### 11.5 Validation and status codes

Routes do **not** attempt strict state-gated validation before submission. They durably append a
`"command"` workflow event and return the generated `commandId` when delivery succeeds. Live-control
commands that are successfully injected into an active in-memory controller are not also queued as
workflow events.

Status-code rules:

- `202` when the command event was accepted for delivery
- `404` when the session/workflow instance does not exist
- terminal-instance errors may still surface when `sendEvent(...)` rejects delivery

Important consequences:

- Command application is decided only when the workflow consumes the event.
- The same command kind may be accepted at submission time and later complete as
  `commandStatus: "rejected"` when it reaches the head of the queue.
- Clients must use `commandId` plus session detail / command history to correlate delivery with
  later application or rejection.
- Route-side state inspection may still be used for UX hints, but not for correctness decisions.

### 11.6 Session row projection

The persisted `pi-fragment.session` row remains a best-effort projection for polling UIs and list
views.

Projection rules:

- Session creation keeps the existing session-level `steeringMode` field on the session row.
- Command routes do **not** override `steeringMode` per command in this redesign.
- `session.updatedAt` is bumped when a command is accepted for delivery and again when the workflow
  consumes that command, whether it is applied or rejected.
- `session.status` is projected as:
  - `active` while an agent operation is running
  - `waiting` while the session is waiting for the next command or waiting for a retry/continue
  - `complete` once the session has been explicitly completed
  - `errored` only for workflow-terminal/invariant failures
  - `paused` / `terminated` continue to mirror workflows instance lifecycle
- Accepting an `abort` command does not by itself mark the session row aborted; the row changes when
  the workflow consumes that abort and/or the live run settles.
- If a process restart occurs during a running agent step, the row projection still reflects the
  durable workflow state, but it does not imply that pre-restart live control injection succeeded.
- This projection is for convenience only; correctness still comes from durable command history plus
  durable step results.

## 12. Session detail / client contract changes

### 12.1 Detail shape

`GET /sessions/:sessionId` must become command/turn-oriented.

Required fields:

- session base fields (`id`, `name`, `status`, `agent`, `steeringMode`, `metadata`, `tags`,
  `createdAt`, `updatedAt`)
- `workflow`
- `turn`
- `phase`
- `waitingFor`
- `messages`
- `trace`
- `turns: PiTurnSummary[]`
- `commandHistory: PiSessionCommandRecord[]`

The old flat `summaries` array is replaced by `turns`.

`commandHistory` must include both consumed commands and accepted-but-not-yet-consumed commands.
Pending accepted commands appear with `commandStatus: "accepted"` and `consumedAt: null`.

The old user-message-centric `events` array is removed from the required contract. If any command
history/event projection is still exposed beyond `commandHistory`, it must be command-oriented and
correlated by `commandId`.

### 12.2 Client store/controller updates

The client session store/controller must stop assuming “sending a message” is the only operation. It
must understand:

- prompt-ready state
- continue-ready state
- running state
- abort availability
- steer/follow-up availability and status
- explicit completion
- command correlation via `commandId`
- pending accepted commands vs consumed applied/rejected commands
- that command submission (`202`) is not the same thing as command application
- that `allowedCommands` is advisory UI state, not a hard server-side submission contract

## 13. Consumer updates

All in-repo consumers must be updated in the same branch.

Expected impact areas:

- `packages/pi-fragment` client store/controller/tests
- `packages/pi-fragment` CLI commands and text rendering
- any routes/tests that use `/sessions/:sessionId/messages`
- `apps/backoffice/app/fragno/bash-runtime/pi-bash-runtime.ts` and its tests, especially the current
  `pi.session.turn` helper that assumes “open active stream + send one message + wait for one
  settled turn”
- backoffice session pages and loaders that currently read `summaries`, `waiting-for-user`, or the
  old message-route response shape
- docs and examples that describe the old API

No compatibility layer or deprecated route period is required.

## 14. Testing and verification

Required coverage:

1. Agent runner unit tests
   - prompt success
   - continue after recoverable error
   - abort outcome
   - invalid continue preconditions
2. Workflow scenario tests
   - prompt creates `do:prompt-*` step history
   - continue creates `do:continue-*` step history
   - abort while running produces explicit abort step and aborted turn status
   - complete transitions to terminal session state
   - invalid commands are rejected and do not mutate state
3. Route tests
   - all new routes
   - accepted submission (`202`) for queued commands
   - returned `commandId` ack shape
   - missing/terminal-instance error behavior
   - detail response shape and waiting state
   - command history correlation for accepted/applied/rejected commands
   - eventual rejected-command results after queued invalid transitions
4. Active session tests
   - replay still works
   - live abort interrupts a running operation
   - live steer injects into a running operation and is later reflected in durable command results
   - live follow-up injects into a running operation and is later reflected in durable command
     results
   - no test in this change claims restart-safe mid-step interruption/injection guarantees
   - current controller is cleaned up on settle
5. CLI/client tests
   - status/action rendering reflects new waiting states
   - steer/follow-up actions and results are rendered coherently
   - command correlation / pending-command rendering is coherent
   - removed message route is no longer referenced

Validation commands after implementation must include the relevant targeted turbo type-check, test,
and build commands for `@fragno-dev/pi-fragment` and direct callers.

## 15. Documentation updates

Update:

- pi fragment route/client docs
- CLI help text and examples
- any backoffice/docs references that still describe message-posting semantics

Examples and docs must describe sessions as **command-driven durable agent runtimes**, not as a thin
chat endpoint. They must also explain that pi-fragment preserves the pi concepts of steering and
follow-up while intentionally simplifying queue semantics where exact in-memory pi parity would be
awkward on top of the workflow engine.
