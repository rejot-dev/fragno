# Fragno Workflows Fragment — Spec

## 0. Open Questions

1. Should auth hook decisions (allow/deny/response) be recorded as explicit trace events by the
   model checker when the workflows fragment runs under tracing, or should this be generalized as a
   core middleware trace hook?
2. Should step-scoped mutations run only when a step completes successfully, or also when a step
   transitions to `waiting` (retry/sleep/event) or `errored`?
3. Should per-step persistence be always-on, or gated behind a runner/config flag for installations
   that prefer the current batch-at-task-boundary behavior?

## 1. Overview

This document specifies a new **Fragno Fragment** that provides a **durable workflow engine**
similar to **Cloudflare Workflows** and conceptually aligned with **Temporal** (durable
orchestration, replay semantics, step retries, timers, and external events).

The fragment must:

- Use **Fragno primitives** (Fragments, routes/services, `@fragno-dev/db` data layer, and durable
  hooks).
- Provide a **Cloudflare Workflows–like developer API** for defining workflows (TypeScript-first,
  `run(event, step)` with `step.do/sleep/sleepUntil/waitForEvent`).
- Provide **HTTP API routes** for:
  - creating/listing workflow instances
  - checking instance status
  - pausing/resuming/terminating/restarting instances
  - sending events to active or future `waitForEvent` calls
  - listing workflow log lines (workflow-authored + engine/system logs)
  - a runner “tick” endpoint for scheduled processing (supported; can be disabled/secured)

## 2. References

- Cloudflare Workflows docs (API + semantics):
  `https://developers.cloudflare.com/workflows/llms-full.txt`
- Fragno DB overview:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/overview.mdx`
- Fragno durable hooks:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
- Example Fragment routes/clients patterns: `example-fragments/example-fragment/src/index.ts`
- Workflow runner: `packages/fragment-workflows/src/runner/process.ts`,
  `packages/fragment-workflows/src/runner/step.ts`,
  `packages/fragment-workflows/src/runner/task.ts`,
  `packages/fragment-workflows/src/runner/state.ts`
- Fragno DB TxResult execution: `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts`

## 3. Terminology

- **Workflow**: a code-defined durable program (definition).
- **Instance**: a single execution of a workflow (has an `instanceId`).
- **Step**: a durable, cached, individually retriable operation (`step.do`) or a durable wait
  (`step.sleep`, `step.sleepUntil`, `step.waitForEvent`).
- **Runner**: a component that advances runnable instances by executing workflow code until it
  reaches a durable wait or completion.
- **Event**: external data sent to an instance and consumed by `waitForEvent`.
- **Replay**: re-executing workflow code from the beginning while returning cached results for
  previously completed steps.

## 4. Goals / Non-goals

### 4.1 Goals

1. **Durability**: instance progress survives process restarts and deploys.
2. **Deterministic replay semantics**: `step.do` is cached; previously completed steps must not run
   again unless explicitly reset via `restart`.
3. **Timers + events**: `sleep/sleepUntil` and `waitForEvent` hibernate the instance and resume
   later.
4. **Retries + timeouts per step**: align with Cloudflare’s `WorkflowStepConfig`.
5. **Cloudflare-like API** for authors and consumers, adapted for the Fragment model.
6. **Composable DB transactions**: use Fragno DB (`withDatabase`, `serviceTx`, `handlerTx`).
7. **Durable hooks**: use Fragno’s durable hooks as an outbox mechanism to reliably signal the
   runner/dispatch mechanism after commits.
8. **Operational visibility**: expose rich state/history plus durable log lines so operators (and
   agents) can understand what is happening.
9. **Step-level durability**: persist each step boundary immediately (not only at task completion)
   and allow step-scoped database mutations to be committed alongside step storage.

### 4.2 Non-goals (initial)

- Exactly-once execution guarantees (target: **at-least-once** with idempotency guidance).
- A hosted multi-tenant “Workflows control plane” (this is a library fragment).
- A full Temporal-compatible API surface (signals/queries, workflow versioning, etc.), unless
  explicitly requested later.

## 5. Packages

All workflow **domain logic** (types, step semantics, DB schema, runner core, Fragment
routes/services) must live in a **single package**. Runtime-specific “wake/dispatch” integrations
live in separate dispatcher packages.

### 5.1 Main Package: `@fragno-dev/workflows` (single source of truth)

Responsibilities:

- Workflow authoring API (Cloudflare-like): `defineWorkflow`, `WorkflowStep`, `WorkflowEvent`,
  `WorkflowStepConfig`, `WorkflowDuration`, `NonRetryableError`
- Instance management API (Cloudflare-like): `Workflow`, `WorkflowInstance`,
  `WorkflowInstanceCreateOptions`, `InstanceStatus`
- Fragno Fragment:
  - DB schema (`withDatabase(...)`)
  - services for instance lifecycle + events
  - HTTP routes for management + runner tick
- Runner core (runtime-agnostic): deterministic replay + scheduling decisions
- Dispatcher interface: a small abstraction used by durable hooks to “wake” the runner.

### 5.2 Dispatcher (Node): `@fragno-dev/db/dispatchers/node`

Responsibilities:

- Provide an in-process durable hooks dispatcher (polling + manual wake).
- Run hook processing outside request lifecycles for Node deployments (server or background worker).

### 5.3 Dispatcher (Cloudflare DO): `@fragno-dev/db/dispatchers/cloudflare-do`

Responsibilities:

- Provide a Cloudflare **Durable Object** alarm handler that processes due durable hooks.
- Schedule alarms from `getNextWakeAt()` and coalesce overlapping runs.
- Recommended integration path for Cloudflare deployments that use Durable Objects.

Note: the main package must remain runtime-agnostic; Cloudflare/Node-specific APIs live in the
`@fragno-dev/db` dispatchers.

Scalability note (future):

- Keep the option open to scale to **one dispatcher DO per workflow name** (still within a DB
  namespace) if a single namespace-level dispatcher becomes a bottleneck.

### 5.4 Management CLI App (NEW): `apps/fragno-wf` (binary: `fragno-wf`)

Responsibilities:

- Provide a **fully featured workflow management CLI** that talks to the **HTTP API** defined by
  this fragment (SPEC §11).
- Work against any deployment target (Node server, Cloudflare DO, etc.) as long as the routes are
  reachable.
- Support: listing workflows, listing/inspecting instances (current status + current step/wait),
  viewing history (optionally including logs), sending events, and pause/resume/restart/terminate.
- Provide **excellent `--help`** with examples and configuration guidance so an agent can
  self-serve.
- Must not require DB access or importing workflow code (HTTP-only).
- Auth is user-defined; the CLI must support passing **arbitrary headers** (repeatable).

## 6. User-facing API (Cloudflare-like)

### 6.1 Workflow definition

Authors define workflows with `defineWorkflow`, providing a workflow name and a `run` function:

```ts
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

export const MyWorkflow = defineWorkflow(
  { name: "my-workflow" },
  async (event: WorkflowEvent<Params>, step: WorkflowStep) => {
    const state = await step.do("fetch config", async () => {
      return { enabled: true };
    });

    await step.sleep("wait a bit", "1 hour");

    const approval = await step.waitForEvent<{ approved: boolean }>("await approval", {
      type: "approval",
      timeout: "24 hours",
    });

    return await step.do("finish", async () => ({ state, approval }));
  },
);
```

### 6.2 Step API (minimum parity)

```ts
export type WorkflowDuration = string | number; // e.g. "10 seconds" or ms

export type WorkflowStepConfig = {
  retries?: {
    limit: number; // supports Infinity
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: WorkflowDuration; // per attempt
};

export type WorkflowLogLevel = "debug" | "info" | "warn" | "error";

// Reserved category: "system" (engine/system logs).
export type WorkflowLogCategory = string;

export type WorkflowLogger = {
  debug(
    message: string,
    data?: unknown,
    options?: { category?: WorkflowLogCategory },
  ): Promise<void>;
  info(
    message: string,
    data?: unknown,
    options?: { category?: WorkflowLogCategory },
  ): Promise<void>;
  warn(
    message: string,
    data?: unknown,
    options?: { category?: WorkflowLogCategory },
  ): Promise<void>;
  error(
    message: string,
    data?: unknown,
    options?: { category?: WorkflowLogCategory },
  ): Promise<void>;
};

// TxResult + HandlerTxContext come from @fragno-dev/db.
export type WorkflowStepTx = {
  // Register serviceTx calls to be executed with the step commit transaction.
  serviceCalls: (factory: () => readonly TxResult<unknown, unknown>[]) => void;
  // Register UOW mutations to run with the step commit transaction.
  mutate: (fn: (ctx: HandlerTxContext) => void) => void;
};

export interface WorkflowStep {
  log: WorkflowLogger;

  do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;

  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;

  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}
```

#### 6.2.1 Durable workflow logs (NEW; structured; workflow + system)

Provide a durable structured logging API that can be surfaced via the history endpoint (behind a
query param) and the management CLI.

Author-facing API (recommended shape):

```ts
await step.log.info(
  "starting run",
  { requestId: event.payload.requestId },
  { category: "workflow" },
);

await step.do("charge customer", async () => {
  await step.log.info("charging", { amount: 125, currency: "usd" }, { category: "payments" });
  // ...
});
```

Log semantics:

- Log lines are **durable** and stored in the fragment database (see `workflow_log` table, §8.5).
- Each log line includes structured fields: `level`, `category`, `message`, `data`, and correlation
  fields (`workflowName`, `instanceId`, `runNumber`, optional `stepKey`/`attempt`).
- Logs do **not** need to be replay-safe. The engine must store `isReplay` so duplicates (caused by
  replay) are obvious and filterable in tooling.
- Category is user-defined; `category="system"` is reserved for engine/system logs (runner state,
  errors, etc.).
- Ordering: logs should be returned in insertion order (by `createdAt`/id) with cursor pagination.

#### 6.2.2 Step-scoped mutations (NEW; executed with step persistence)

Workflow steps may register **step-scoped database mutations** that run in the _same transaction_
that persists the step record (see §9.1.4/§9.1.5). This enables efficient use of `serviceTx` without
opening a separate handler transaction inside the step body.

Example:

```ts
await step.do("persist-user", async (tx) => {
  const user = await buildUserProfile();

  tx.serviceCalls(() => [usersService.createUser(user), auditService.logUserCreate(user)]);

  return user;
});
```

Rules:

- Step-scoped mutations are **buffered** during the step callback and executed only when the step is
  persisted.
- Mutations **do not run** during replay when the step is already completed.
- Mutations run **after** the step callback returns successfully (they cannot influence the step
  return value).
- If a step attempt fails and is scheduled for retry, any buffered mutations for that attempt are
  discarded.
- If a step requires reads that affect its output, use an explicit handler transaction in the step
  body (outside the step-scoped mutation buffer).

Step method semantics:

- `step.do`:
  - Must **cache** its return value (JSON-serializable) per instance + step identity.
  - The callback receives a `WorkflowStepTx` to register step-scoped mutations (see §6.2.2).
  - If a cached completed result exists during replay, it must be returned without calling the
    callback.
  - If the callback throws:
    - If the error is `NonRetryableError`, do **not** retry; fail instance.
    - Otherwise apply retry policy (default + per-step override) and transition the instance into a
      waiting state until the next retry.
- `sleep/sleepUntil`:
  - Must persist a “wake time” and transition the instance into `waiting`.
  - Must not count towards “max steps” if we implement a step limit (Cloudflare doesn’t count them).
- `waitForEvent`:
  - Must persist the expected `type` and a timeout.
  - If a matching buffered event already exists, return it immediately (and mark delivered).
  - Otherwise transition to `waiting` and resume when an event arrives or when the timeout triggers.
  - Default timeout: **24 hours** (Cloudflare-like).
  - Allowed timeout range: **1 second** to **365 days** (Cloudflare-like).
  - Timeout behavior: when it times out, `waitForEvent` throws; workflow code can `try/catch` to
    continue (Cloudflare-like).

### 6.3 Instance management API (Cloudflare-like)

Programmatic interface (in addition to HTTP):

```ts
export type InstanceStatus = {
  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  error?: { name: string; message: string };
  output?: unknown;
};

export interface WorkflowInstance {
  id: string;
  status(): Promise<InstanceStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  sendEvent(options: { type: string; payload?: unknown }): Promise<void>;
}

export interface WorkflowInstanceCreateOptions<TParams = unknown> {
  id?: string;
  params?: TParams;
}

export interface WorkflowInstanceCreateOptionsWithId<TParams = unknown>
  extends WorkflowInstanceCreateOptions<TParams> {
  id: string;
}

export interface Workflow<TParams = unknown> {
  create(options?: WorkflowInstanceCreateOptions<TParams>): Promise<WorkflowInstance>;
  createBatch(batch: WorkflowInstanceCreateOptionsWithId<TParams>[]): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
}
```

Status meanings (Cloudflare-like):

- `active`: eligible to run; execution will begin on the next tick.
- `waiting`: hibernating (sleep, retry delay, or waiting for an event/timeout).
- `paused`: explicitly paused by user; runner must not advance until resumed.
- `complete|terminated|errored`: terminal.

### 6.4 `NonRetryableError` (Cloudflare-like)

Provide a `NonRetryableError` type that stops retries when thrown inside `step.do`:

```ts
export class NonRetryableError extends Error {
  constructor(message: string, name?: string);
}
```

### 6.5 Programmatic Workflow Bindings (no `env`)

Cloudflare Workflows exposes bindings on `env.MY_WORKFLOW`. Fragno does not have an `env` concept,
so this fragment exposes an equivalent **programmatic bindings object**.

At fragment creation time, the host registers workflows with:

- a **workflow name** (used for HTTP routes, DB scoping, and observability)
- a **binding key** (a JS identifier used for programmatic access)

Example:

```ts
export type WorkflowsRegistry = Record<string, WorkflowDefinition>;

const workflows = {
  BILLING: BillingWorkflow,
  CHILD: ChildWorkflow,
} as const;

const fragment = createWorkflowsFragment({ workflows }, { databaseAdapter });

// Programmatic start (equivalent to env.BILLING.create)
const billing = fragment.workflows.BILLING;
const instance = await billing.create({ id: "order-123", params: { orderId: "order-123" } });
```

Rules:

- `workflows.<bindingKey>` exposes the `Workflow` interface (`create/get/createBatch`) for that
  workflow definition.
- The HTTP API uses `:workflowName` (the registered `name`), not the binding key.

### 6.6 Fragno Runtime (Time + Randomness)

Workflows must use a shared Fragno runtime for **time** and **randomness** so tests and model
checking can control these sources of nondeterminism consistently across fragments.

Runtime interface (from `@fragno-dev/core`):

```ts
export type FragnoRuntime = {
  time: {
    now: () => Date;
  };
  random: {
    float: () => number; // [0, 1)
    uuid: () => string;
    cuid: () => string;
  };
};
```

Rules:

- Workflow instance IDs use `runtime.random.float()` (or `uuid()`/`cuid()` if configured that way)
  rather than `Math.random`.
- Runner IDs use `runtime.random.uuid()` rather than `crypto.randomUUID`.
- All workflow timestamps (`createdAt`, `runAt`, `wakeAt`, etc.) use `runtime.time.now()`.
- The workflows fragment must not call `new Date()` or `Math.random()` directly except inside the
  runtime default implementation.
- `FragnoRuntime` is exported from `@fragno-dev/core` as a stable API for fragments and tests.

## 7. Fragment responsibilities

### 7.1 What the fragment provides

1. A database schema for:
   - instances
   - step results + step execution metadata
   - waits (sleep/event)
   - buffered events
   - execution history + durable log records (workflow-authored + optional system)
2. Services that implement instance lifecycle operations.
3. API routes (HTTP) that expose these services.
4. Durable hooks that reliably signal the runner/dispatcher after commits.
5. A runner implementation and/or runner integration points.

### 7.2 Workflow registration (code-only)

- Workflow definitions are registered in code and provided to the fragment at instantiation time.
- No runtime “registration” or dynamic evaluation is supported (no `eval` / remote code).
- `GET /workflows` reflects the statically registered workflow set.

### 7.3 What the host app provides

- A Fragno DB adapter (`FragnoPublicConfigWithDatabase`) and migrations execution (via `fragno-cli`
  or `@fragno-dev/db` `migrate()` where relevant).
- A **Fragno runtime** (`FragnoRuntime`) providing time and randomness (SPEC §6.6).
- Any authentication/authorization policy for management endpoints (configurable).
- A way to run/wake the runner (all supported):
  - in-process (Node) via `@fragno-dev/db/dispatchers/node`
  - HTTP “tick” endpoint invoked by cron/scheduler
  - Cloudflare Durable Object runtime via `@fragno-dev/db/dispatchers/cloudflare-do`

### 7.4 WorkflowsFragmentConfig (runtime-focused)

```ts
export interface WorkflowsFragmentConfig {
  workflows?: WorkflowsRegistry;
  dispatcher?: WorkflowsDispatcher;
  runner?: WorkflowsRunner;
  runtime: FragnoRuntime;

  authorizeRequest?: WorkflowsAuthorizeHook<WorkflowsAuthorizeContext>;
  authorizeInstanceCreation?: WorkflowsAuthorizeHook<WorkflowsAuthorizeInstanceCreationContext>;
  authorizeManagement?: WorkflowsAuthorizeHook<WorkflowsAuthorizeManagementContext>;
  authorizeSendEvent?: WorkflowsAuthorizeHook<WorkflowsAuthorizeSendEventContext>;
  authorizeRunnerTick?: WorkflowsAuthorizeHook<WorkflowsAuthorizeRunnerTickContext>;
}
```

Notes:

- `runtime` is required; `clock` is removed in favor of `runtime.time`.

## 8. Data model (proposed)

All tables live under the fragment’s DB namespace (Fragno DB namespacing).

### 8.1 `workflow_instance`

Required columns (suggested):

- `id` (FragnoId): internal primary key
- `instanceId` (string, unique per `workflowName`)
- `workflowName` (string)
- `status` (string enum; mirrors InstanceStatus.status)
- `createdAt`, `updatedAt`, `startedAt`, `completedAt` (timestamps)
- `params` (json)
- `output` (json, nullable)
- `errorName` (string, nullable), `errorMessage` (string, nullable)
- `retentionUntil` (timestamp, nullable) — for GC/pruning (default: `null` = infinite retention)
- `runNumber` (integer) — increments on `restart` (keeps `instanceId` stable)

Indexes:

- unique: (`workflowName`, `instanceId`)
- (`workflowName`, `status`, `updatedAt`)

### 8.2 `workflow_step`

Represents durable steps and durable waits (sleep/event) uniformly.

- `id` (FragnoId)
- `workflowName` (string)
- `instanceId` (string)
- `runNumber` (integer)
- `stepKey` (string) — deterministic identifier (see 9.2)
- `name` (string, <= 256 chars)
- `type` ("do" | "sleep" | "waitForEvent")
- `status` ("pending" | "waiting" | "completed" | "errored")
- `attempts` (integer)
- `maxAttempts` (integer)
- `timeoutMs` (integer, nullable)
- `nextRetryAt` (timestamp, nullable)
- `wakeAt` (timestamp, nullable) — for sleep/event timeout
- `waitEventType` (string, nullable)
- `result` (json, nullable)
- `errorName`, `errorMessage` (nullable)
- `createdAt`, `updatedAt`

Indexes:

- unique: (`workflowName`, `instanceId`, `runNumber`, `stepKey`)
- (`workflowName`, `instanceId`, `runNumber`, `createdAt`) // history listing
- (`workflowName`, `instanceId`, `runNumber`, `status`, `wakeAt`) // optional wait queries
- (`status`, `nextRetryAt`) // optional retry queries

### 8.3 `workflow_event`

- `id` (FragnoId)
- `workflowName` (string)
- `instanceId` (string)
- `runNumber` (integer) — the instance run this event belongs to
- `type` (string, <= 100 chars, pattern `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`)
- `payload` (json, nullable)
- `createdAt` (timestamp)
- `deliveredAt` (timestamp, nullable)
- `consumedByStepKey` (string, nullable)

Indexes:

- (`workflowName`, `instanceId`, `runNumber`, `type`, `deliveredAt`)
- (`workflowName`, `instanceId`, `runNumber`, `createdAt`) // history listing

### 8.4 `workflow_task` (required)

A minimal durable queue for the runner.

- `id` (FragnoId)
- `workflowName`
- `instanceId`
- `runNumber` (integer) — the instance run this task targets
- `kind` ("run" | "resume" | "retry" | "wake" | "gc")
  - `gc` is reserved for future retention/GC tooling (not required in v1)
- `runAt` (timestamp)
- `status` ("pending" | "processing" | "completed" | "failed")
- `attempts` / `maxAttempts`
- `lastError` (string, nullable)
- `lockedUntil` (timestamp, nullable)
- `lockOwner` (string, nullable)
- `createdAt`, `updatedAt`

Index:

- (`status`, `runAt`)
- (`status`, `lockedUntil`)
- unique: (`workflowName`, `instanceId`, `runNumber`) // single active task per instance run

Task lifecycle:

- `workflow_task` is an **internal durable queue**, not part of the instance history.
- Implementations should delete tasks once `completed` (or prune them periodically) while keeping
  `workflow_instance`, `workflow_step`, and `workflow_event` forever (infinite retention).

### 8.5 `workflow_log` (NEW; recommended)

Durable log lines emitted by workflow code (and optionally by the engine for system events).

- `id` (FragnoId)
- `workflowName` (string)
- `instanceId` (string)
- `runNumber` (integer)
- `stepKey` (string, nullable) — step name that produced the log line (when applicable)
- `attempt` (integer, nullable) — step attempt number (for `step.do`-scoped logs)
- `level` ("debug" | "info" | "warn" | "error")
- `category` (string, <= 64 chars; reserved: "system")
- `message` (string, <= 2048 chars)
- `data` (json, nullable)
- `isReplay` (boolean)
- `createdAt` (timestamp)

Indexes:

- (`workflowName`, `instanceId`, `runNumber`, `createdAt`) // paging/tailing
- (`workflowName`, `instanceId`, `runNumber`, `level`, `createdAt`) // optional filtering
- (`workflowName`, `instanceId`, `runNumber`, `category`, `createdAt`) // optional filtering

## 9. Execution model

### 9.1 Runner responsibilities

The runner continuously (or on demand) does:

1. Find due runnable tasks from DB.
2. Claim one unit of work in a transaction (avoid double-processing).
3. Execute workflow code until:
   - a durable wait is reached (sleep/event/next retry)
   - a pause is reached
   - completion/failure
4. Persist resulting state transitions and schedule the next task, if any.

#### 9.1.1 Distributed runner safety (MUST)

The system must support **distributed runners**: multiple processes/servers (or multiple concurrent
tick calls) may run the runner at the same time.

Invariants:

- At most one runner may advance a given `(workflowName, instanceId, runNumber)` at a time.
- Runner work is **idempotent**: duplicate task delivery and retries must not corrupt persisted
  state (at-least-once execution model).
- Locks are leases: if a runner crashes mid-step, another runner can recover after lease expiry.

Required mechanism (OCC + leases on tasks):

- Use a DB-backed **lease** on `workflow_task` (single active task per instance run; see §8.4):
  - A task is claimable if:
    - `status="pending" AND runAt<=now`, OR
    - `status="processing" AND lockedUntil<=now` (crash recovery)
  - Claiming is implemented with Fragno DB optimistic concurrency control:
    - retrieve a candidate task row (includes `_version`)
    - update it to `status="processing"`, set `lockOwner=<runnerId>`, `lockedUntil=now+leaseMs`
    - use `.check()` so only one runner can claim
  - The runner must ensure `lockedUntil` does not expire while it is executing user code:
    - simplest: configure `leaseMs >= max step timeout (+ buffer)`
    - recommended: renew the lease periodically while executing (heartbeat) to avoid accidental
      takeover during long-running steps

Additionally (OCC guardrails):

- All runner state transitions that touch `workflow_instance` must use Fragno OCC `.check()`
  updates.
- Runner writes must verify `runNumber` has not changed (restart) before committing terminal status
  changes; if it changed, runner must stop and treat the task as superseded.

The **HTTP tick endpoint** must be safe under concurrent invocation (multiple tick callers are
equivalent to distributed runners).

#### 9.1.2 Task ordering (Cloudflare-like)

Cloudflare prioritizes instances resuming from `waiting` over newly `active` instances. We replicate
this by ordering claimed tasks so that “resume/wake/retry” work runs before “start new runs”.

Requirement:

- Runner task selection must prioritize tasks for instances that are resuming (`wake|retry|resume`)
  over tasks that are starting (`run`), and within a priority bucket should process oldest `runAt`
  first.

#### 9.1.3 Task scheduling rules

- The `workflow_task` row for a given `(workflowName, instanceId, runNumber)` represents the **next
  scheduled time** the runner should attempt to advance that run.
- v1 keeps a **single task row per instance run** (unique index in SPEC §8.4). Scheduling “work”
  means inserting that row if missing, or updating `runAt` earlier/later as needed.
- The runner must not claim tasks for instances in `paused` or terminal states; task selection
  should filter by instance status to avoid “hot looping” on paused instances.
- Typical scheduling transitions:
  - `create|resume|restart`: `runAt=now`, `kind="run"|"resume"`
  - `step.sleep/sleepUntil`: `runAt=wakeAt`, `kind="wake"`
  - `step.waitForEvent`: `runAt=timeoutAt`, `kind="wake"` (for the timeout path)
  - step retry: `runAt=nextRetryAt`, `kind="retry"`
  - matching `sendEvent` for an instance currently waiting on that event type (and not paused):
    update task to `runAt=now`, `kind="wake"`

#### 9.1.4 Step persistence per boundary (NEW)

The runner must **persist step state after every step boundary**, not only when the task completes.
This ensures step history and logs survive runner crashes mid-run.

Definition:

- A **step boundary** is any transition to `completed`, `waiting`, or `errored` for `step.do`, and
  any transition to `waiting` or `completed` for `sleep/sleepUntil/waitForEvent`.

Requirements:

- After each step boundary, the runner **flushes** the in-memory step/log/event buffers to the DB.
- If the workflow run is still **executing** (i.e., more steps remain in the same tick), the flush
  **must not** reschedule the task or change instance status (beyond updating `updatedAt`).
- If the boundary **suspends** or **completes** the run (waiting/paused/complete/errored), the flush
  may be combined with the existing instance/task transition transaction.
- Per-step persistence is **always-on** by default; if a config gate is introduced, it must preserve
  backward compatibility with the existing batch behavior.

#### 9.1.5 Step-scoped mutations execution (NEW)

Step-scoped mutations (§6.2.2) are executed inside the **same handler transaction** that persists
the step boundary.

Rules:

- Mutations are **buffered per step** and executed only for the attempt that reaches a successful
  boundary.
- Runner commits **service calls first**, then applies runner state mutations (`workflow_step`,
  `workflow_event`, `workflow_log`, `workflow_instance.updatedAt`).
- If a concurrency conflict occurs while committing a step boundary, the runner must **stop** and
  let the next tick re-hydrate state from the DB (no in-memory retry loops).
- If the step commit fails due to a **unique constraint** violation, the step must be treated as a
  **non-retryable failure** (equivalent to `NonRetryableError` thrown inside the step).

### 9.2 Step identity & replay

Cloudflare uses step names + engine-managed ordering; we need deterministic identity to safely cache
results.

Approach (Cloudflare-like):

- Steps are **cached by their names** (Cloudflare-like).
- `stepKey` is the **step name** (the first argument you pass to `step.do/sleep/...`), optionally
  normalized (e.g. trimmed) but not re-ordered or auto-indexed by the engine.
- Calling `step.*` multiple times with the same `name` refers to the **same cached step** (it does
  not create “another step”).
- On replay, each `step.*` call:
  - checks DB for an existing `workflow_step` record for
    `(workflowName, instanceId, runNumber, stepKey)`
  - if completed, returns cached result
  - otherwise executes the behavior for that step type and persists it at the step boundary

Rules for authors (Cloudflare-like):

- **Name steps deterministically**: non-deterministic names (for example including `Date.now()`)
  will prevent caching and may cause steps to re-run if later steps fail.
- Use stable names and include loop indices / unique IDs in step names inside loops.
- Avoid conditional logic that changes which steps run under the same step names across replays.

Concurrency note (Cloudflare-like):

- The engine must support concurrent step evaluation patterns like
  `await Promise.all([step.do("a", ...), step.do("b", ...)])` as long as step names are distinct.
- Calling the same `step.*` name concurrently is undefined and should throw (duplicate stepKey).

### 9.3 Retry behavior

Defaults (Cloudflare-like):

```ts
const defaultStepConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: 10_000, backoff: "exponential" },
  timeout: "10 minutes",
};
```

Implementation requirements:

- Retry delay is **scheduled**, not implemented via in-process `setTimeout` (to preserve
  durability).
- A failed attempt persists the error and schedules `nextRetryAt`.
- Retried attempts must re-enter the workflow via replay and re-invoke the same stepKey.
- Step attempt timeouts are **best-effort**:
  - treat a timed-out attempt as a failure and schedule retry (or fail the instance if retries are
    exhausted / `NonRetryableError`)
  - do not assume the runtime can abort arbitrary JS execution; timeouts may not stop user code
  - if an attempt completes after a timeout, its result must not be persisted as successful
    (OCC/runNumber checks must prevent stale writes)

### 9.4 Pause / resume / terminate / restart

State transitions should be Cloudflare-like and idempotent where reasonable.

- `pause()`:
  - enqueue a system pause event for the instance and schedule a tick
  - runner consumes pause events before executing user code and sets status `paused`
  - active or waiting instances pause on the next tick without executing user code
  - if already `paused`, no-op
  - if `complete|terminated|errored`, error
- `resume()`:
  - if `paused`, set status `active` and enqueue a run task for `now`
  - otherwise no-op (Cloudflare docs: resume on non-paused has no effect)
- `terminate()`:
  - if `complete|terminated|errored`, error
  - otherwise set status `terminated` and prevent further progress
- `restart()`:
  - increment `runNumber`
  - keep all prior runs for audit (do not delete); runner always scopes by `runNumber`
  - clear waits and mark instance status `active`
  - enqueue a run task for `now`
  - do not deliver buffered events from prior runs (events are scoped by `runNumber`)
  - note: “cancel in-progress steps” is best-effort; if user code is currently executing, it may run
    to completion, but OCC guards must prevent it from committing changes to the new run
- Pausing does **not** freeze timers:
  - `sleep/sleepUntil` wake times and `waitForEvent` timeouts keep counting while `paused`
  - tasks may become due while paused but must not be claimed/executed until resumed

### 9.5 Event buffering semantics

- Events can be sent immediately after instance creation; if the instance has not yet reached the
  matching `waitForEvent`, the event must remain buffered.
- Events sent while an instance is `paused` must be buffered and delivered after resume.
- Event records are scoped to an instance run:
  - `sendEvent` records events with the instance’s current `runNumber`
  - `waitForEvent` only consumes events for the current `runNumber`
- When a `waitForEvent(type=X)` is evaluated:
  - if buffered events exist for X, return the oldest undelivered event and mark it delivered
  - else persist the wait request and hibernate

### 9.6 Rules of Workflows (Best Practices)

These are Cloudflare-style guidance and should be documented prominently:

- **No side effects outside `step.do`**: logic outside steps may re-run on replay/resume.
- **Make steps idempotent**: steps can retry; ensure external calls are safe to repeat.
- **Make steps granular**: keep one logical operation per step; avoid multiple unrelated API calls.
- **Always `await` step calls** (`await step.do`, `await step.sleep`, etc.) to avoid dangling
  promises.
- **Keep step return values under 1 MiB**; store large data externally and return references.
- **Take care with `Promise.race()` / `Promise.any()`**: surround them with `step.do(...)` to ensure
  deterministic caching across replays.
- **Instance IDs are unique per workflow**: don’t reuse business IDs directly; use composite IDs or
  random IDs and store mappings if you need “many instances per user”. Random IDs should be
  generated via `FragnoRuntime.random`, not `Math.random`.

## 10. Durable hooks integration (required)

Fragno durable hooks are used as the **outbox** mechanism to reliably notify a dispatcher/runner
after state-changing commits.

### 10.1 Hook definition

The fragment definition must `provideHooks(...)` with (at minimum):

- `onWorkflowEnqueued` — triggered when the fragment creates a runnable task (instance create,
  resume, event arrival, retry scheduling)

Payload:

```ts
type WorkflowEnqueuedHookPayload = {
  workflowName: string;
  instanceId: string;
  reason: "create" | "event" | "resume" | "retry" | "wake";
};
```

### 10.2 Hook execution semantics

- Hook triggers must be registered inside the same DB transaction that creates/updates the instance
  and/or task.
- Hook execution runs after commit and is retried by Fragno durable hooks retry policy.

### 10.3 Dispatcher adapters (proposed)

The fragment config should allow wiring durable hook execution to a real “wake mechanism”:

- Node/in-process: `runner.wake()` (set a flag / resolve a promise) so the poll loop runs quickly.
- HTTP/self-call: `fetch(<tick-endpoint>)`.
- Cloudflare: use the Durable Object dispatcher (`@fragno-dev/db/dispatchers/cloudflare-do`) to run
  and schedule via alarms and/or trigger ticks.

If no dispatcher is provided, the system still works with polling, but with higher latency.

## 11. HTTP API (routes)

All routes are mounted under the Fragment’s `mountRoute` (default: `/api/<fragmentName>`).

### 11.1 List workflows

- `GET /workflows`
  - Returns: `{ workflows: { name: string }[] }`

### 11.2 List instances

- `GET /workflows/:workflowName/instances`
  - Query: `{ status?: InstanceStatus["status"]; pageSize?: number; cursor?: string }`
  - Returns:
    `{ instances: { id: string; details: InstanceStatus }[]; cursor?: string; hasNextPage: boolean }`
  - Notes:
    - must be index-backed (no full table scans)
    - pagination should use Fragno DB cursor patterns (see
      `packages/fragment-mailing-list/src/definition.ts`)

### 11.3 Create instance

- `POST /workflows/:workflowName/instances`
  - Body: `{ id?: string; params?: unknown }`
  - Returns: `{ id: string; details: InstanceStatus }`
  - Semantics (Cloudflare-like):
    - If `id` is provided and an instance with that ID exists (not deleted), return
      `INSTANCE_ID_ALREADY_EXISTS`
    - To re-run an existing instance ID, call `restart` (do not call `create` again)
  - Errors:
    - `WORKFLOW_NOT_FOUND`
    - `INSTANCE_ID_ALREADY_EXISTS`
    - `INVALID_INSTANCE_ID`

### 11.4 Create batch

- `POST /workflows/:workflowName/instances/batch`
  - Body: `{ instances: { id: string; params?: unknown }[] }` (max 100)
  - Returns: `{ instances: { id: string; details: InstanceStatus }[] }`
  - Semantics (Cloudflare-like):
    - idempotent: existing IDs are skipped
    - skipped IDs are **excluded** from the returned array

### 11.5 Get instance status

- `GET /workflows/:workflowName/instances/:instanceId`
  - Returns:
    ```ts
    {
      id: string;
      details: InstanceStatus;
      meta: {
        workflowName: string;
        runNumber: number;
        params: unknown;
        createdAt: Date;
        updatedAt: Date;
        startedAt: Date | null;
        completedAt: Date | null;
        currentStep?: {
          stepKey: string;
          name: string;
          type: string;
          status: string;
          attempts: number;
          maxAttempts: number;
          timeoutMs: number | null;
          nextRetryAt: Date | null;
          wakeAt: Date | null;
          waitEventType: string | null;
          error?: { name: string; message: string };
        };
      };
    }
    ```
  - Errors: `INSTANCE_NOT_FOUND`

### 11.6 Pause / resume / terminate / restart

- `POST /workflows/:workflowName/instances/:instanceId/pause`
- `POST /workflows/:workflowName/instances/:instanceId/resume`
- `POST /workflows/:workflowName/instances/:instanceId/terminate`
- `POST /workflows/:workflowName/instances/:instanceId/restart`
  - Returns: `{ ok: true }` (or updated status)
  - Semantics: see SPEC §9.4
  - Errors (recommended):
    - `INSTANCE_NOT_FOUND`
    - `INSTANCE_TERMINAL` (pause/terminate when `complete|terminated|errored`)

### 11.7 Send event

- `POST /workflows/:workflowName/instances/:instanceId/events`
  - Body: `{ type: string; payload?: unknown }`
  - Returns: `{ status: InstanceStatus }`
  - Semantics: buffered delivery (Cloudflare-like + pause support):
    - store the event even if the instance is `active`, `waiting`, or `paused`
    - deliver when the workflow reaches a matching `waitForEvent(type)`
    - reject if the instance is `complete`, `terminated`, or `errored`
    - does not create instances (instance must exist)
    - if the instance is currently waiting on a matching `waitForEvent(type)` and is not `paused`,
      enqueue/wake the runner immediately
  - Errors:
    - `INSTANCE_NOT_FOUND`
    - `INVALID_EVENT_TYPE`
    - `INSTANCE_TERMINAL`

### 11.8 History / debugging (recommended)

- `GET /workflows/:workflowName/instances/:instanceId/history`
  - Query:
    `{ runNumber?: number; pageSize?: number; stepsCursor?: string; eventsCursor?: string; order?: "asc"|"desc"; includeLogs?: boolean; logsCursor?: string; logLevel?: "debug"|"info"|"warn"|"error"; logCategory?: string }`
  - Returns:

    ```ts
    {
      runNumber: number;
      steps: unknown[];
      events: unknown[];
      stepsCursor?: string;
      stepsHasNextPage: boolean;
      eventsCursor?: string;
      eventsHasNextPage: boolean;

      // Only when includeLogs=true
      logs?: {
        id: string;
        runNumber: number;
        stepKey: string | null;
        attempt: number | null;
        level: "debug" | "info" | "warn" | "error";
        category: string;
        message: string;
        data: unknown | null;
        isReplay: boolean;
        createdAt: Date;
      }[];
      logsCursor?: string;
      logsHasNextPage?: boolean;
    }
    ```

  - Notes:
    - logs are omitted unless `includeLogs=true`
    - `category="system"` is reserved for engine/system logs
    - Requirement: keep full step results + events + logs (no opt-out)

### 11.9 Runner tick (supported; protect it)

- `POST /_runner/tick`
  - Body: `{ maxInstances?: number; maxSteps?: number }`
  - Returns: `{ processed: number }`
  - Must be protected (not public) or be disabled by default.

## 12. Security / Authorization

The fragment must not impose a single auth model; instead provide hooks/config:

- `authorizeRequest?(ctx)`: called by every route; can throw or return an error response.
- Separate policies for:
  - instance creation
  - reading instance status/history/logs
  - management operations (pause/resume/terminate/restart)
  - sending events
  - runner tick

Guidance:

- Auth hooks should be deterministic and rely on `FragnoRuntime` for time/randomness so they can be
  traced and replayed under the model checker.

## 13. Limits & validation (defaults; configurable)

Adopt Cloudflare-compatible defaults where practical:

- Workflow name length: <= 64
- Instance ID length: <= 100; pattern `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`
- Event type length: <= 100; same pattern
- `step.do` name length: <= 256
- Step result payload max: 1 MiB (enforced at storage boundary)
- Event payload max: 1 MiB
- Log message length: <= 2048
- Log category length: <= 64; reserved: `system`
- Log data payload max: 1 MiB
- All params/event payloads/step results must be JSON-serializable; large data must be stored
  externally by the user and returned as references (no built-in blob store in v1).
- Max steps per run: 1024 (default; configurable)
- Max sleep duration: 365 days

## 14. Operational concerns

### 14.1 Garbage collection

Retention is **infinite** by default (keep everything always). v1 does **not** include an explicit
instance deletion API.

Notes:

- `retentionUntil` exists for future retention policies, but defaults to `null` (infinite).
- Operators who need to reclaim storage can manually delete rows at the DB level; future versions
  may add GC tooling and/or an admin-only delete endpoint.
- `workflow_task` rows are internal queue state and **should be compacted**:
  - delete tasks when `completed` (or periodically prune completed tasks) to avoid unbounded growth.

### 14.2 Observability

At minimum:

- status and error surfaced via `InstanceStatus`
- a history endpoint for step results/errors and wait reasons
- durable workflow-authored log lines (SPEC §6.2.1, §8.5, §11.8)
- optional engine/system logs written by the runner (host-controlled; same surface as workflow logs)
- a first-class management CLI that can consume the above (SPEC §5.4, §17)

### 14.3 Workflow testability (author-facing)

Workflow authors should be able to test their workflows without spinning up HTTP servers or real
dispatchers. Provide a **test harness** that integrates with Fragno-test and supports:

- deterministic runner execution driven by `tick()`/`runUntilIdle()` from tests
- a controllable runtime clock for `sleep` and timeout behavior (advance time explicitly)
- seeded runtime randomness for deterministic instance IDs and runner IDs
- direct event injection to instances (equivalent to `sendEvent`)
- access to instance status/history for assertions

The harness should be easy to wire for user-defined workflows such as
`example-apps/fragno-db-usage-drizzle/src/fragno/workflows-fragment.ts`:

- reuse the same `workflows` registry and schema
- allow overriding dispatcher/polling with a no-op test dispatcher
- expose helpers to create instances and advance work in a tight loop

This is **not** a new production runtime; it is a developer-only testing surface.

## 15. Workflow Code Upgrades (Cloudflare-like)

Workflow code is **code-defined** and may change across deployments. The engine should follow
Cloudflare-style expectations:

- The runner executes the **currently deployed** workflow implementation (no per-instance pinning).
- The engine does **not** block execution if workflow code changes.
- Workflow authors are responsible for maintaining determinism/compatibility across code upgrades:
  - avoid changing step ordering/branching in ways that break replay
  - if breaking changes are needed, publish a new `workflowName` (versioned name) and migrate
    callers

## 16. Decisions (Locked)

1. Single domain package: `@fragno-dev/workflows` (SPEC §5.1)
2. Dispatcher entrypoints:
   - Node: `@fragno-dev/db/dispatchers/node` (SPEC §5.2)
   - Cloudflare DO: `@fragno-dev/db/dispatchers/cloudflare-do` (SPEC §5.3)
3. Runner models supported: in-process, HTTP tick, and Cloudflare DO scheduling (SPEC §7.3, §10.3)
4. Distributed runners required and must be well tested (SPEC §9.1.1)
5. Retention: infinite by default; keep full history always (SPEC §11.8, §14.1)
6. No explicit instance delete API in v1 (SPEC §14.1)
7. Programmatic starts via `fragment.workflows.<bindingKey>.create/get/createBatch` (SPEC §6.5)
8. `sendEvent` buffers for `active|waiting|paused` and rejects for `complete|terminated|errored`
   (SPEC §9.5, §11.7)
9. `createBatch` excludes skipped IDs from the response (Cloudflare-like) (SPEC §11.4)
10. `sendEvent` does not create instances (SPEC §11.7)
11. Pausing does not freeze sleep/event timeouts (SPEC §9.4)
12. Step attempt timeouts are best-effort (SPEC §9.3)
13. Workflows runtime uses `FragnoRuntime`; `clock` is removed from config (SPEC §6.6, §7.4)

## 17. Workflow Management CLI (NEW; app: `fragno-wf`)

We want a **fully featured workflow management CLI** that uses the **workflow fragment HTTP API** to
inspect and operate workflows end-to-end.

Requirements:

- Lives under `apps/fragno-wf` (SPEC §5.4) and ships the `fragno-wf` binary.
- Uses only the workflow fragment HTTP routes (no DB access; no importing workflow code).
- CLI takes the **full workflow fragment base URL** (e.g. `https://host/api/workflows`) rather than
  composing from host/mount/fragment pieces.
- Makes it possible to understand:
  - which workflows exist
  - which instances are active/waiting/paused/errored
  - what the current step is (or last step + wait reason)
  - what happened (history + events + logs)
- Outputs human-friendly text only (if machine output is needed, call the HTTP API directly).
- Supports user-defined auth by allowing arbitrary repeatable headers (e.g.
  `-H "Authorization: ..."`).
- Provides excellent `--help` so an agent can self-serve:
  - command tree, options, env vars/config
  - examples for common operations

Recommended command surface (draft):

- `fragno-wf workflows list` → `GET /workflows`
- `fragno-wf instances list --workflow <name> [--status <status>]` →
  `GET /workflows/:workflowName/instances`
- `fragno-wf instances get --workflow <name> --id <instanceId> [--full]` →
  `GET /workflows/:workflowName/instances/:instanceId`
- `fragno-wf instances history --workflow <name> --id <instanceId> [--run <n>] [--include-logs] [--log-level <level>] [--log-category <category>]`
  → `GET /workflows/:workflowName/instances/:instanceId/history`
- `fragno-wf instances logs --workflow <name> --id <instanceId> [--run <n>] [--follow] [--log-level <level>] [--log-category <category>]`
  → `GET /workflows/:workflowName/instances/:instanceId/history` (with `includeLogs=true`)
- `fragno-wf instances create --workflow <name> [--id <instanceId>] [--params <json>]` →
  `POST /workflows/:workflowName/instances`
- `fragno-wf instances pause|resume|restart|terminate --workflow <name> --id <instanceId>` →
  management routes
- `fragno-wf instances send-event --workflow <name> --id <instanceId> --type <type> [--payload <json>]`
  → `POST /events`

Non-goals:

- CLI does not expose `createBatch` or runner tick (call the HTTP API directly if needed).

## 18. Documentation (NEW; separate docs section)

Workflow docs must be **separate from Fragno docs**, similar to existing `Stripe` and `Forms`
sections.

Requirements:

- Add a top-level docs section at `/docs/workflows` with its own `meta.json`.
- Wire it into the docs nav (update `apps/docs/content/docs/meta.json` to include `workflows`,
  similar to `stripe` and `forms`).
- Provide a landing/quickstart page (similar to Forms’ `index.mdx`) that covers:
  - installation
  - defining workflows
  - mounting routes
  - running dispatchers/ticks
  - using the management CLI
- Recommended initial page structure (draft):
  - `index` (Quickstart / landing)
  - `concepts` (durability, determinism, replay, retries)
  - `routes` (HTTP API reference)
  - `cli` (CLI reference + examples)
  - `debugging` (history/logs, common failure modes)
- Keep `/docs/fragno/for-users/workflows` as a short pointer page to the new docs (avoid broken
  links), but treat `/docs/workflows` as the source of truth.

## 19. Potential workflow feature additions (brainstorm)

No additional workflow feature additions are planned as part of this spec update. Deferred ideas
(for later):

1. **Instance labels/tags + query filters** (e.g. `labels: { tenantId, orderId }`) and list/search
   endpoints.
2. **Concurrency controls** per workflow (max active instances), plus queue depth visibility.
3. **Dead-letter / manual retry tooling**: re-enqueue, retry now, reset a step, retry a failed run.
4. **Signals/queries** (Temporal-like): “send signal” distinct from events; “query current state”
   without replaying.
5. **Cron/scheduled workflow triggers** (native schedule definitions).
6. **OpenTelemetry metrics/tracing** integration (step timings, retries, wait times, error rates).
7. **Web dashboard** (optional) powered by the same API/CLI primitives.
8. **Retention policies + GC tooling** (admin-only) for long-running installations.

## 20. Decisions (locked)

- CLI lives under `apps/` as `fragno-wf` (binary: `fragno-wf`).
- CLI takes the full workflow fragment base URL (e.g. `https://host/api/workflows`).
- CLI supports arbitrary repeatable headers for user-defined auth.
- CLI outputs human-friendly text only (no JSON mode).
- CLI does not expose `createBatch` or runner tick.
- `instances get` prints a summary by default; `--full` includes params/output and extra metadata.
- Logs are structured, durable, and may appear during replay; the engine stores `isReplay` to make
  this clear.
- Logs are returned via the history endpoint when `includeLogs=true` and include `level` and
  `category` (reserved: `system`).
- Logs follow the same retention policy as instances (infinite by default).
- Steps are persisted at **every step boundary**, not only at task completion.
- Step-scoped mutations execute in the **same transaction** as step persistence and do not affect
  the step return value.
- Step-scoped mutation commits that fail due to **unique constraint** violations are treated as
  **non-retryable step failures**.
- No additional workflow feature additions are planned right now.

## 21. FP Issue Plan

Plan issue: **Workflows: per-step persistence + step-scoped mutations**

Success criteria:

- Step state (steps/logs/events) is persisted after every step boundary.
- Step-scoped mutations can register `serviceTx` calls and commit in the same transaction as step
  persistence.
- Runner behavior remains deterministic and replay-safe; retries and conflicts are handled without
  duplicate side effects.

Child issues:

1. **Define step mutation API + types** (Spec §6.2.2)
   - Add `WorkflowStepTx` to the public API and document callback semantics.
   - Update workflow examples to demonstrate `tx.serviceCalls`.
2. **Runner state + buffers for step-scoped mutations** (Spec §9.1.5)
   - Extend runner state to store per-step mutation buffers and clear them on retries.
3. **Per-step persistence refactor** (Spec §9.1.4)
   - Introduce a step-boundary flush path that commits step/log/event updates while keeping the
     instance `active` when more steps remain.
   - Ensure task/instance transitions are still committed when the run suspends or completes.
4. **Execute step-scoped mutations in step commits** (Spec §9.1.5)
   - Merge buffered `serviceTx` calls + mutation callbacks into the step commit transaction.
   - Define ordering: service calls → runner step mutations → commit.
5. **Tests + docs updates** (Spec §6.2.2, §9.1.4, §9.1.5)
   - Add runner tests for step flush frequency, replay safety, and mutation execution ordering.
   - Update docs/examples to note step-scoped mutation semantics and limitations.
