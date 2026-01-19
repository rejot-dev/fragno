# Fragno AI Fragment — SPEC (Draft)

Status: Draft (v0.6)

## 1. Overview

This document specifies a new **Fragno Fragment** that provides a **durable, full-stack AI runtime**
for:

1. **Threads** (persisted history, settings, metadata)
2. **Durable agent runs** (server-side execution with NDJSON streaming; provider tools in v0.1)
3. **Background Deep Research jobs** using **OpenAI Responses** with `background: true` + **OpenAI
   Webhooks** for completion callbacks

The fragment is intended to be a “complete setup in the full stack”: HTTP API routes, DB-backed
state, typed client bindings, and integration points for custom tools and UX.

### 1.1 Why this Fragment exists

Fragno already makes it easy to expose typed routes and client bindings, but the existing example
chat fragment (`example-fragments/chatno`) is intentionally minimal:

- no persistence of conversations
- no durable agent loop / tool execution semantics
- no background jobs and no webhook integration

Meanwhile, `pi-mono` provides excellent building blocks for multi-provider LLM calls and agent loops
(streaming, tool calling, state, compaction patterns, proxy protocols), but it does not provide a
database-backed backend or durable side-effect handling.

This fragment combines the strengths:

- **pi** for LLM + agent primitives
- **Fragno DB + durable hooks** for persistence and reliable eventing
- **Fragno routes** for a neat, composable HTTP API surface

### 1.2 Primary building blocks leveraged from pi (and OpenAI)

This fragment is designed to integrate well with `pi-mono` building blocks, but v0.1 can ship with
an **OpenAI-only** engine that uses the OpenAI Responses API directly (mirroring
`example-fragments/chatno`), and adds pi integration incrementally.

Planned integrations:

- `@mariozechner/pi-ai`: unified multi-provider streaming + tool calling types (v0.2+).
- `@mariozechner/pi-agent-core`: agent loop that executes **server-side custom tools** and emits
  UI-friendly events (v0.2+; v0.1 uses provider tools only).

Key pi patterns we intentionally mirror:

- event-driven agent lifecycle (`agent_start`, `message_update`, `tool_execution_*`, …)
- steering/follow-up queues
- proxying patterns (optional; out of scope for v0.1)

## 2. Goals / Non-goals

### 2.1 Goals

**Goals (v0.1)**

1. **Durable threads**: persist thread settings + message history.
2. **Durable runs**: represent each execution attempt as a first-class entity with a lifecycle.
3. **OpenAI-only execution**: run LLM calls server-side via the OpenAI Responses API.
4. **Streaming UX (NDJSON)**: stream deltas/events to the client while persisting the final outputs
   and run state transitions (disconnect-safe).
5. **Deep Research**: support OpenAI deep research models as background jobs + OpenAI webhook
   callbacks, producing a **structured artifact**.
6. **Runner/tick design**: provide an in-process runner and an HTTP tick endpoint that is safe under
   concurrent invocation (modeled after the Workflows fragment runner/tick semantics).
7. **Idempotency + resilience**: webhook ingestion is idempotent; OpenAI calls use idempotency keys
   where applicable; provider/network disconnects are handled with well-defined retries/failures.
8. **Composability**: keep domain logic in fragment services; routes are thin wrappers.

**Goals (v0.2+)**

- **Custom tools**: allow host apps (and other fragments) to contribute server-executed tools with
  typed argument validation (pi-agent-core integration).
- **Run steering/follow-up**: optional “steer” and “follow-up” messages for interactive agents.

### 2.2 Non-goals (v0.1)

- A full pi-coding-agent replacement (branching trees, editor UI, etc.)
- A complete RAG platform (vector DB integrations, indexing pipelines, etc.)
- A hosted multi-tenant “AI control plane” with billing (the fragment is a library)
- Built-in authentication/authorization (v0.1 routes are open; host apps can add auth later)
- Server-executed custom tools + approvals (provider tools only in v0.1)
- Exactly-once delivery semantics (target: at-least-once with idempotency)
- Browser-only agent execution (this fragment runs server-side)

## 3. Terminology

- **Thread**: a persisted conversation container (settings + history).
- **Message**: user/assistant/system messages; persisted to DB (append-only in v0.1).
- **Run**: an execution attempt that advances a thread (LLM call(s) + tool executions).
- **Run Event**: a persisted state transition and/or important execution milestone.
- **Live Stream Event**: transient delta events streamed to the client during a run.
- **Tool**: a callable operation the LLM can invoke (function calling).
- **Deep Research Run**: a run type that uses OpenAI Responses with `background: true` and completes
  via webhook.
- **Runner**: a component that processes queued work (queued runs, unprocessed webhook events).

## 4. Packages

### 4.1 Main package: `@fragno-dev/fragment-ai` (single source of truth)

Responsibilities:

- DB schema and services for threads/messages/runs/events/artifacts
- OpenAI agent run execution (foreground streaming + background processing)
- OpenAI Deep Research run orchestration + webhook ingestion
- Runner tick processing (queued runs + webhook events)
- Public HTTP routes + typed client bindings
- Integration hooks/callbacks for runtime-specific needs (runner wake-ups; future auth/tools)

### 4.2 Optional runtime integrations (future)

These are optional in v0.1 but likely useful:

- No AI-specific dispatcher packages in v0.1.
- Host apps can either:
  - call `POST /ai/_runner/tick` periodically (cron/interval), and/or
  - **reuse** the existing Workflows dispatcher packages by pointing them at the AI tick endpoint
    (may require a small generalization so the dispatcher can target arbitrary tick paths):
    - Node: `@fragno-dev/workflows-dispatcher-node` → `/ai/_runner/tick`
    - Cloudflare DO: `@fragno-dev/workflows-dispatcher-cloudflare-do` → `/ai/_runner/tick`
- Future: `@fragno-dev/fragment-ai-proxy` for pi-agent proxy compatibility (`/api/stream`) for
  browser UIs.

## 5. High-level Architecture

### 5.1 Data flow: agent runs (foreground stream + background)

1. Client creates/uses a **thread**
2. Client appends a user message
3. Client starts an agent run via one of:
   - **Foreground stream**: `POST /ai/threads/:threadId/runs:stream` → returns `runId` + NDJSON live
     events
   - **Background**: `POST /ai/threads/:threadId/runs` with
     `{ type: "agent", executionMode: "background" }` → returns `{ runId }` and the client
     polls/subscribes for completion
4. Server executes the run via OpenAI Responses:
   - stream LLM deltas/events (foreground only)
   - use **provider tools only** in v0.1 (e.g. OpenAI Web Search), with no server-executed tools
   - persist final assistant message(s) + coarse run events

Client disconnect handling:

- Live deltas are transient (not required to be replayable).
- The run **must still complete and persist** even if the client disconnects mid-stream (see §9.4).

### 5.2 Data flow: deep research run (background + webhook)

1. Client posts a deep research request (creates a run in `queued` state)
2. Runner picks up queued run, calls OpenAI Responses with `background: true`, storing the returned
   `response_id` on the run
3. OpenAI sends a webhook (`response.completed` / `response.failed` / …)
4. Webhook route verifies the signature and persists the event (idempotent)
5. Processing fetches the full Response from OpenAI by `response_id`, persists final
   artifacts/messages, and marks the run complete/failed

### 5.3 Runner model (tick-based; modeled after Workflows)

v0.1 does **not** integrate with the Workflows fragment, but it should follow the same _runner/tick_
design:

- A `POST /ai/_runner/tick` endpoint processes bounded batches of work.
- Durable hooks can “wake” the runner after commits, but correctness does not depend on hooks.
- Tick must be safe under concurrent invocation and process work at-least-once with idempotency.
- Concurrency control is **optimistic** (OCC via Fragno DB `_version` checks); no locks/leases.
- The tick endpoint is intentionally shaped like the Workflows runner tick so host apps can reuse
  the Workflows dispatcher packages (Node + Cloudflare DO) with a configurable tick path.

The runner processes:

- queued agent runs (`type="agent"`, `executionMode="background"`)
- queued deep research runs (`type="deep_research"`)
- unprocessed OpenAI webhook deliveries

Future: the same domain model should allow swapping in a more durable runner implementation (e.g.
Workflows fragment, a queue worker) without changing the public HTTP contract.

### 5.4 Durable hooks usage (outbox pattern)

Durable hooks are used to reliably “poke” the runner after DB commits, e.g.:

- enqueue a durable hook payload `AiWakeEvent = { type: "run.queued", runId }` to wake the runner to
  pick up work quickly
- enqueue a durable hook payload
  `AiWakeEvent = { type: "openai.webhook.received", openaiEventId, responseId }` to wake the runner
  for webhook follow-up

Durable hooks run **after commit** and are retried with exponential backoff if they fail. This is
especially important for webhooks: the webhook route should persist the event and trigger a durable
hook, then return `200` without doing heavy work.

Hooks are an accelerator, not a correctness dependency; periodic `POST /ai/_runner/tick` must still
work.

## 6. Public Configuration

This fragment is a library; it must not hardcode auth or hosting concerns. v0.1 is **OpenAI-only**
and uses an API key configured on the fragment instance.

### 6.1 Server config

```ts
export interface AiFragmentConfig {
  /**
   * OpenAI Platform API key (server-owned). v0.1 is OpenAI-only.
   */
  openaiApiKey: string;

  /**
   * Optional: base URL for OpenAI-compatible backends.
   */
  openaiBaseUrl?: string;

  /**
   * Default model for interactive agent runs (e.g. "gpt-5-nano").
   */
  defaultAgentModel?: string;

  /**
   * Default model for deep research runs (e.g. "o3-deep-research").
   * Should track the newest model recommended by OpenAI docs.
   */
  defaultDeepResearchModel?: string;

  /**
   * OpenAI webhook secret (one per fragment configuration). Configured in the OpenAI dashboard by
   * the user.
   */
  openaiWebhookSecret?: string;

  /**
   * Runner integration (wake-up strategy). Optional but recommended.
   * Modeled after the Workflows fragment runner/tick semantics.
   */
  runner?: {
    /**
     * Optional platform-specific wake-up mechanism. This is typically invoked from a durable hook
     * handler (so wake-ups are retried and do not make the original HTTP request fail).
     */
    onWake?: (event: AiWakeEvent) => Promise<void> | void;
    maxWorkPerTick?: number;
  };

  /**
   * Run-level retry policy used by the runner when (re)starting runs.
   * This is distinct from any HTTP-level retries the OpenAI SDK may perform internally.
   *
   * Defaults mirror pi's provider retry defaults (MAX_RETRIES = 3).
   */
  retries?: {
    /**
     * Maximum total attempts per run (including the first attempt).
     * Default: 4 (1 initial + 3 retries).
     */
    maxAttempts?: number;

    /**
     * Base delay in ms for exponential backoff between attempts.
     * Default: 2000ms → 2s, 4s, 8s.
     */
    baseDelayMs?: number;
  };

  /**
   * Persistence policies
   */
  storage?: {
    /**
     * Whether to persist assistant streaming deltas as run events.
     * Default: false (deltas are transient; final messages are persisted).
     */
    persistDeltas?: boolean;

    /**
     * Whether to persist raw OpenAI Responses objects into artifacts/events for debugging.
     *
     * Default: false (store only structured outputs + stable identifiers).
     */
    persistOpenAIRawResponses?: boolean;

    /**
     * v0.1 default: infinite retention (no automatic deletion).
     */
    retentionDays?: number | null;
  };
}

export type AiWakeEvent =
  | { type: "run.queued"; runId: string }
  | { type: "openai.webhook.received"; openaiEventId: string; responseId: string };
```

## 7. Database Schema

All tables are namespaced under the fragment namespace (Fragno DB default).

Fragno DB automatically adds internal columns to every table:

- `_internalId` (hidden) for joins/foreign keys
- `_version` (hidden) for optimistic concurrency control (OCC)

All public-facing `id` columns use `idColumn()` (CUID strings) by default, so IDs are stable and
opaque (not sequential/guessable).

The AI runner uses `_version` checks (no locks/leases) to avoid double-processing under concurrent
ticks.

### 7.1 `ai_thread`

Represents a conversation thread.

Notes:

- A thread is the primary unit of history + configuration.
- Provider tool configuration is stored on the thread (v0.1) so different threads can enable/disable
  OpenAI hosted tools (e.g. web search).

Columns:

- `id` (id)
- `title` (string, nullable)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)
- `defaultModelId` (string) — OpenAI model id
- `defaultThinkingLevel` (string) — `"off" | "minimal" | ...`
- `systemPrompt` (string, nullable)
- `openaiToolConfig` (json, nullable) — per-thread OpenAI tool configuration (see §8)
- `metadata` (json, nullable) — freeform host metadata

Indexes:

- `idx_updatedAt` on `(updatedAt)`

### 7.2 `ai_message`

Persisted conversation history.

Columns:

- `id` (id)
- `threadId` (id, FK)
- `role` (string enum): `"user" | "assistant" | "system"` (future: `"toolResult"`)
- `content` (json) — pi-ai message shape (or an internal superset)
- `text` (string, nullable) — denormalized plain text for preview/search
- `createdAt` (timestamp)
- `runId` (id, nullable) — which run produced it (assistant/toolResult)

Indexes:

- `idx_thread_createdAt` on `(threadId, createdAt)`
- optional: `idx_thread_text` for search if supported by driver

### 7.3 `ai_run`

Execution attempt.

Columns:

- `id` (id)
- `threadId` (id, FK)
- `type` (string enum): `"agent" | "deep_research"`
- `executionMode` (string enum):
  - `foreground_stream` — run is started by a streaming request handler
  - `background` — run is picked up by the runner tick
  - (deep research runs are always `background`)
- `status` (string enum):
  - `queued` — waiting for runner
  - `running` — currently executing
  - `waiting_webhook` — deep research awaiting webhook
  - `processing_webhook` — runner processing webhook
  - `succeeded` | `failed` | `cancelled`
- `createdAt`, `updatedAt`
- `startedAt`, `completedAt` (nullable)
- `modelId`, `thinkingLevel`, `systemPrompt` (snapshotted)
- `inputMessageId` (id, nullable) — the user message that triggered the run
- `error` (string, nullable)
- `attempt` (int) — attempt counter for retries (starts at 1)
- `maxAttempts` (int) — default 4 (1 initial + 3 retries); host may override
- `nextAttemptAt` (timestamp, nullable) — set when scheduling a retry

OpenAI fields (nullable; used by both agent and deep research runs):

- `openaiResponseId` (string)
- `openaiLastWebhookEventId` (string)

Indexes:

- `idx_thread_createdAt` on `(threadId, createdAt)`
- `idx_status_nextAttemptAt` on `(status, nextAttemptAt, updatedAt)` — for runner polling
- `idx_openaiResponseId` on `(openaiResponseId)` (unique)

### 7.4 `ai_run_event`

Durable run timeline events (coarse-grained; optional deltas).

Columns:

- `id` (id)
- `runId` (id, FK)
- `seq` (int) — monotonic per run
- `type` (string) — e.g. `run.started`, `llm.requested`, `tool.called`, `run.completed`
- `payload` (json)
- `createdAt` (timestamp)

Indexes:

- `idx_run_seq` on `(runId, seq)` unique

### 7.5 `ai_tool_call`

Tracks tool invocations emitted by the model.

Notes:

- v0.1 uses **provider tools only** (OpenAI-hosted), so this table is primarily for v0.2+
  server-executed custom tools.

Columns:

- `id` (id)
- `runId` (id, FK)
- `toolCallId` (string) — stable ID from the model/tool calling protocol
- `toolName` (string)
- `args` (json)
- `status` (string enum): `pending | running | completed | failed | skipped`
- `result` (json, nullable)
- `isError` (boolean)
- `createdAt`, `updatedAt`

Indexes:

- `idx_run_toolCallId` on `(runId, toolCallId)` unique

### 7.6 `ai_artifact`

Structured outputs produced by runs.

v0.1 uses this for **deep research** results (a structured artifact), but the table is generic so it
can store additional artifact types later (e.g. plans, code patches, reports).

Columns:

- `id` (id)
- `runId` (id, FK)
- `threadId` (id, FK)
- `type` (string) — v0.1: `deep_research_report`
- `title` (string, nullable)
- `mimeType` (string) — e.g. `application/json`, `text/markdown`
- `data` (json) — structured payload (see §10.5)
- `text` (string, nullable) — optional preview/denormalization
- `createdAt`, `updatedAt`

Indexes:

- `idx_run_createdAt` on `(runId, createdAt)`
- `idx_thread_createdAt` on `(threadId, createdAt)`

### 7.7 `ai_openai_webhook_event`

Idempotency + audit for OpenAI webhook deliveries.

Columns:

- `id` (id) — internal
- `openaiEventId` (string) — the webhook event `id` (unique)
- `type` (string) — `response.completed|response.failed|...`
- `responseId` (string)
- `payload` (json) — full decoded webhook event
- `receivedAt` (timestamp)
- `processedAt` (timestamp, nullable)
- `processingError` (string, nullable)

Indexes:

- `idx_openaiEventId` unique
- `idx_processedAt` on `(processedAt)` — runner selects `processedAt is null`

## 8. Tools

### 8.1 v0.1: provider tools only

v0.1 supports **provider tools only** (OpenAI-hosted tools configured via the Responses API, such as
web/research/search tools recommended by OpenAI). The fragment does **not** execute server-side
custom tools and does **not** implement tool approval flows.

Default: **no tools enabled**. Threads must explicitly set `openaiToolConfig` to enable provider
tools.

Provider tool configuration lives on the thread (`ai_thread.openaiToolConfig`) so different threads
can opt into different tool surfaces. v0.1 treats this config as **pass-through JSON** that is
merged into the OpenAI Responses request options (no validation).

```ts
export type AiOpenAIToolConfig = Record<string, unknown>;
```

Any tool usage details that OpenAI includes in the Response can be:

- mapped to simplified live events (NDJSON) for the frontend
- optionally persisted as `ai_run_event` rows for debugging

### 8.2 v0.2+: custom tools (future)

Future versions can add a tool registry that allows host apps (and other fragments) to contribute
server-executed tools (pi-agent-core integration), with optional approval/policy hooks.

## 9. Agent Execution Semantics

### 9.1 What is persisted vs streamed

To avoid “write per token” load, v0.1 separates:

- **Live stream**: token deltas and fine-grained events, sent to clients during the request.
- **Persistence**: final assistant message(s) and coarse run events.

`config.storage.persistDeltas` can optionally persist deltas as `ai_run_event` rows, but the default
is `false`.

### 9.2 Run state machine (agent runs)

States and transitions:

- `queued` → `running` (runner starts; or streaming handler starts the run)
- `running` → `succeeded | failed | cancelled`
- `failed` → `queued` (optional retry when `attempt < maxAttempts` and `nextAttemptAt` is set)

### 9.3 Steering + follow-up (future)

If enabled:

- `POST /ai/runs/:runId/steer` inserts a steering message (stored in DB)
- `POST /ai/runs/:runId/follow-up` inserts follow-up messages

Runner checks these queues between tool executions and at turn boundaries (mirrors pi-agent-core
behavior).

### 9.4 Client disconnect semantics (required)

When the client disconnects from an NDJSON streaming response:

1. The server must stop attempting to write to the response stream.
2. The run must **continue executing** (best-effort) and must still persist:
   - final assistant message
   - run status transition to `succeeded|failed|cancelled`

Implementation requirement:

- Do **not** couple the upstream OpenAI request abort signal to the HTTP response stream abort
  signal. Client disconnect is not the same as a run cancel.

Durability recommendation:

- In deployments with short request lifetimes (serverless), prefer `executionMode="background"` and
  use the streaming endpoint only as a best-effort “tap” on live progress.

### 9.5 Provider disconnect semantics (required)

v0.1 must assume the server may lose the connection to OpenAI mid-run (timeouts, network blips,
process restarts). The fragment should treat this differently from a client disconnect:

- **Client disconnect**: stop writing NDJSON, but keep consuming the upstream OpenAI stream and
  persist final state when possible (§9.4).
- **Provider disconnect**: mark the run as `failed` **or** schedule a retry (depending on progress
  and configured retry policy).

Recommended v0.1 policy:

1. Use OpenAI idempotency keys for `responses.create(...)` calls where possible (e.g.
   `idempotencyKey = "ai:" + runId + ":attempt:" + attempt`) so a retry does not create duplicate
   responses.
2. Persist `ai_run.openaiResponseId` as soon as it becomes known (for streaming runs, capture it
   from the earliest stream event that includes the response id).
3. If the upstream stream breaks after `openaiResponseId` is known:
   - runner tick may attempt `openai.responses.retrieve(openaiResponseId)` until the Response is
     `completed|failed`, then persist final messages/artifacts and complete the run
4. If `openaiResponseId` is not known:
   - runner tick may retry `responses.create(...)` up to `maxAttempts`, with backoff controlled by
     `nextAttemptAt` (default backoff: 2s, 4s, 8s; see `config.retries`)

## 10. Deep Research (OpenAI background responses + webhooks)

### 10.1 Run creation

Deep research runs are always processed by the runner (asynchronous). API call creates a run with:

- `type = "deep_research"`
- `status = "queued"`

Runner later calls OpenAI:

- model: `config.defaultDeepResearchModel` (recommended default: newest OpenAI deep research model)
- `background: true`
- input: thread messages + a run-specific research prompt
- request options: set `idempotencyKey` derived from `(runId, attempt)` to make retries safe

The runner stores `openaiResponseId` and sets:

- `status = "waiting_webhook"`

### 10.2 Webhook ingestion

Route: `POST /ai/webhooks/openai`

Requirements:

- Verify signature using OpenAI webhook signing headers:
  - `webhook-id`, `webhook-timestamp`, `webhook-signature`
- Accept only the configured secret (`config.openaiWebhookSecret`)
- Persist webhook event idempotently (`openaiEventId` unique)
- Extract `responseId` from payload and associate to `ai_run` via `openaiResponseId`
- Enqueue a durable hook wake-up after commit so webhook handling runs later with retries (the
  webhook route itself should stay fast and reliable). The durable hook handler can call
  `config.runner?.onWake(...)` or directly trigger `POST /ai/_runner/tick`.

### 10.3 Webhook processing

Deep research is completed by the **runner**:

1. Runner picks up queued deep research runs:
   - calls `openai.responses.create({ background: true, ... })`
   - stores `openaiResponseId` on the run
   - moves run to `waiting_webhook`
2. Webhook deliveries are stored idempotently in `ai_openai_webhook_event`.
3. Runner processes unprocessed webhook events:
   - retrieves the Response from OpenAI by `responseId`
   - on completion:
     - persists a **structured artifact** (`ai_artifact`)
     - appends an **assistant** `ai_message` that references the artifact
     - marks the run `succeeded`
   - on failure, marks the run `failed` and stores the error (optionally storing an artifact with
     partial details)

Edge case: webhook arrives before the run has stored `openaiResponseId`. This is handled by:

- persisting the webhook event first (by `openaiEventId`)
- runner matching runs by `openaiResponseId` once available (indexed/unique)

### 10.4 Failure + retries

Webhook events are at-least-once. Processing must be idempotent:

- `ai_openai_webhook_event.openaiEventId` is unique.
- Runner processing uses optimistic concurrency control:
  - mark webhook events processed with an update that only succeeds when `processedAt is null`
  - treat concurrent “already processed” outcomes as a no-op (not an error)

If fetching OpenAI response fails:

- keep webhook event `processedAt = null`
- set `processingError`
- runner will retry later (bounded by host policy)

### 10.5 Structured artifact output (v0.1)

Deep research produces a structured artifact persisted in `ai_artifact`:

```ts
export type AiArtifactType = "deep_research_report";

export interface AiDeepResearchArtifactData {
  type: "deep_research_report";
  formatVersion: 1;
  modelId: string;
  openaiResponseId: string;
  reportMarkdown: string;
  sources?: Array<{ url: string; title?: string; snippet?: string }>;
  usage?: unknown;
  rawResponse?: unknown; // only when `config.storage.persistOpenAIRawResponses === true`
}
```

On completion, the runner also appends an **assistant** `ai_message` to the thread that references
the artifact (see §11.8.1 message `content` guidance).

## 11. HTTP Routes (Proposed)

### 11.1 Threads

- `POST /ai/threads`
- `GET /ai/threads`
- `GET /ai/threads/:threadId`
- `PATCH /ai/threads/:threadId`

Admin-only (host must protect):

- `DELETE /ai/admin/threads/:threadId`

### 11.2 Messages

- `POST /ai/threads/:threadId/messages`
- `GET /ai/threads/:threadId/messages`

### 11.3 Runs

- `POST /ai/threads/:threadId/runs` (agent or deep research)
- `GET /ai/threads/:threadId/runs`
- `GET /ai/runs/:runId`
- `POST /ai/runs/:runId/cancel`

### 11.4 Live run streaming

Two complementary patterns:

1. Foreground run: `POST /ai/threads/:threadId/runs:stream` returns NDJSON stream of live events
2. Persisted event replay: `GET /ai/runs/:runId/events` streams persisted run events (and can be
   used to resume UI after refresh)

### 11.5 Artifacts

- `GET /ai/runs/:runId/artifacts`
- `GET /ai/artifacts/:artifactId`

### 11.6 Webhooks

- `POST /ai/webhooks/openai`

### 11.7 Runner

- `POST /ai/_runner/tick` — process queued runs + webhook events (host-protect it)
  - Modeled after the Workflows fragment `POST /_runner/tick` semantics.

### 11.8 Route contracts (detailed)

This section defines the minimum v0.1 contract for inputs/outputs and error codes.

#### 11.8.1 Shared response shapes

Error response shape (Fragno standard):

```ts
type ApiError<TCode extends string> = { message: string; code: TCode };
```

Thread object:

```ts
export interface AiThread {
  id: string;
  title: string | null;
  systemPrompt: string | null;
  defaultModelId: string;
  defaultThinkingLevel: string;
  openaiToolConfig: unknown | null;
  metadata: unknown | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

Message object:

```ts
export interface AiMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system"; // future: "toolResult"
  content: unknown; // stored pi-ai message shape (or compatible internal superset)
  text: string | null;
  runId: string | null;
  createdAt: string; // ISO
}
```

v0.1 `content` conventions (recommended; not enforced):

- User message text: `{ type: "text", text: string }`
- Assistant message text: `{ type: "text", text: string }`
- Deep research completion: `{ type: "artifactRef", artifactId: string }`

Run object:

```ts
export type AiRunType = "agent" | "deep_research";
export type AiRunExecutionMode = "foreground_stream" | "background";
export type AiRunStatus =
  | "queued"
  | "running"
  | "waiting_webhook"
  | "processing_webhook"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AiRun {
  id: string;
  threadId: string;
  type: AiRunType;
  executionMode: AiRunExecutionMode;
  status: AiRunStatus;
  modelId: string;
  thinkingLevel: string;
  systemPrompt: string | null;
  inputMessageId: string | null;
  openaiResponseId: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
  startedAt: string | null; // ISO
  completedAt: string | null; // ISO
}
```

Artifact object:

```ts
export interface AiArtifact {
  id: string;
  runId: string;
  threadId: string;
  type: string; // v0.1: "deep_research_report"
  title: string | null;
  mimeType: string;
  data: unknown;
  text: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

#### 11.8.2 Threads

**Create thread**

- `POST /ai/threads`
- Body:
  - `title?: string`
  - `systemPrompt?: string`
  - `defaultModelId?: string`
  - `defaultThinkingLevel?: string`
  - `openaiToolConfig?: unknown` (per-thread provider tools config; see §8)
  - `metadata?: unknown`
- Defaults:
  - `defaultModelId` defaults to `config.defaultAgentModel`
  - `defaultThinkingLevel` defaults to `"off"` (mirrors pi defaults)
  - `systemPrompt`, `openaiToolConfig`, `metadata` default to `null`
- Returns: `{ thread: AiThread }`
- Errors: `VALIDATION_ERROR`

**List threads**

- `GET /ai/threads`
- Query (optional):
  - `pageSize?: number`
  - `cursor?: string`
- Returns: `{ threads: AiThread[]; cursor?: string; hasNextPage: boolean }`
- Errors: `VALIDATION_ERROR`

**Get thread**

- `GET /ai/threads/:threadId`
- Returns: `{ thread: AiThread }`
- Errors: `THREAD_NOT_FOUND`

**Update thread**

- `PATCH /ai/threads/:threadId`
- Body: subset of create fields (all optional)
- Returns: `{ thread: AiThread }`
- Errors: `THREAD_NOT_FOUND`, `VALIDATION_ERROR`

**Delete thread (admin-only)**

- `DELETE /ai/admin/threads/:threadId`
- Returns: `{ ok: true }`
- Errors: `THREAD_NOT_FOUND`

#### 11.8.3 Messages

**Append message**

- `POST /ai/threads/:threadId/messages`
- Body (v0.1):
  - `role: "user"` (server-generated assistant/tool messages only)
  - `content: unknown` (recommended: `{ type: "text", text: string }`)
- Returns: `{ message: AiMessage }`
- Errors: `THREAD_NOT_FOUND`, `VALIDATION_ERROR`

**List messages**

- `GET /ai/threads/:threadId/messages`
- Query (optional):
  - `pageSize?: number`
  - `cursor?: string`
- Returns: `{ messages: AiMessage[]; cursor?: string; hasNextPage: boolean }`
- Errors: `THREAD_NOT_FOUND`, `VALIDATION_ERROR`

#### 11.8.4 Runs

**List runs**

- `GET /ai/threads/:threadId/runs`
- Query (optional):
  - `pageSize?: number`
  - `cursor?: string`
- Returns: `{ runs: AiRun[]; cursor?: string; hasNextPage: boolean }`
- Errors: `THREAD_NOT_FOUND`, `VALIDATION_ERROR`

**Create run (async)**

- `POST /ai/threads/:threadId/runs`
- Body:
  - `type: "agent" | "deep_research"`
  - `executionMode?: "background"` (v0.1 default; streaming uses `runs:stream`)
  - `inputMessageId?: string` (optional; if omitted, the latest user message is used)
  - `modelId?: string` (override)
  - `thinkingLevel?: string` (override)
  - `systemPrompt?: string` (override)
  - For deep research: `researchPrompt?: string` (optional, appended to system prompt)
- Defaults:
  - `modelId`, `thinkingLevel`, `systemPrompt` default to the thread’s settings
- Returns: `{ run: AiRun }`
- Errors:
  - `THREAD_NOT_FOUND`
  - `VALIDATION_ERROR`
  - `NO_USER_MESSAGE` (if there is no suitable input message)

**Start run (stream)**

- `POST /ai/threads/:threadId/runs:stream`
- Body:
  - `type?: "agent"` (deep research is background-only in v0.1)
  - `inputMessageId?: string` (optional; if omitted, the latest user message is used)
  - `modelId?: string` (override)
  - `thinkingLevel?: string` (override)
  - `systemPrompt?: string` (override)
- Defaults:
  - `modelId`, `thinkingLevel`, `systemPrompt` default to the thread’s settings
- Returns: NDJSON stream of `AiRunLiveEvent` (see §11.9)
- Errors:
  - `THREAD_NOT_FOUND`
  - `VALIDATION_ERROR`
  - `NO_USER_MESSAGE`

**Get run**

- `GET /ai/runs/:runId`
- Returns: `{ run: AiRun }`
- Errors: `RUN_NOT_FOUND`

**Cancel run**

- `POST /ai/runs/:runId/cancel`
- Returns: `{ ok: true }` (or `{ run: AiRun }`)
- Errors:
  - `RUN_NOT_FOUND`
  - `RUN_TERMINAL` (already completed)

**Run events replay (persisted)**

- `GET /ai/runs/:runId/events`
- Returns: NDJSON stream of persisted `ai_run_event` rows (schema depends on persistence choice)
- Errors: `RUN_NOT_FOUND`

#### 11.8.5 Artifacts

**List artifacts for a run**

- `GET /ai/runs/:runId/artifacts`
- Returns: `{ artifacts: AiArtifact[] }`
- Errors: `RUN_NOT_FOUND`

**Get artifact**

- `GET /ai/artifacts/:artifactId`
- Returns: `{ artifact: AiArtifact }`
- Errors: `ARTIFACT_NOT_FOUND`

#### 11.8.6 Webhooks (OpenAI)

- `POST /ai/webhooks/openai`
  - Body: raw JSON string (must verify signature against headers)
  - Returns: `{ ok: true }`
  - Errors:
    - `WEBHOOK_NOT_CONFIGURED` (400)
    - `INVALID_SIGNATURE` (401)
    - `VALIDATION_ERROR` (400)

#### 11.8.7 Runner tick

- `POST /ai/_runner/tick`
  - Body: `{ maxRuns?: number; maxWebhookEvents?: number }`
  - Returns: `{ processedRuns: number; processedWebhookEvents: number }`
  - Errors: `VALIDATION_ERROR`

### 11.9 Live NDJSON stream event schema (v0.1)

The foreground streaming endpoint returns NDJSON where each line is a JSON object.

v0.1 recommended approach: map OpenAI Responses streaming events into a **simplified, stable**
frontend event schema. This avoids the frontend depending on OpenAI’s exact event union while still
supporting rich UX (tool lifecycles, citations, etc.).

This mapping is best-effort; not all models/tools emit all events.

```ts
export type AiToolCallStatus =
  | "in_progress"
  | "searching"
  | "interpreting"
  | "generating"
  | "completed"
  | "failed";

export type AiRunLiveEvent =
  | { type: "run.meta"; runId: string; threadId: string }
  | { type: "run.status"; runId: string; status: "running" | "cancelled" | "failed" | "succeeded" }
  | { type: "output.text.delta"; runId: string; delta: string }
  | { type: "output.text.done"; runId: string; text: string }
  | {
      type: "tool.call.started";
      runId: string;
      toolCallId: string; // OpenAI output item id (or `${call_id}|${item_id}` for function calls)
      toolType: string; // e.g. "web_search_call", "file_search_call", "function_call"
      toolName?: string; // for function calls
    }
  | {
      type: "tool.call.status";
      runId: string;
      toolCallId: string;
      toolType: string;
      status: AiToolCallStatus;
    }
  | { type: "tool.call.arguments.delta"; runId: string; toolCallId: string; delta: string }
  | { type: "tool.call.arguments.done"; runId: string; toolCallId: string; arguments: string }
  | {
      type: "tool.call.output";
      runId: string;
      toolCallId: string;
      toolType: string;
      output: unknown;
      isError?: boolean;
    }
  | { type: "run.final"; runId: string; status: AiRunStatus; run: AiRun };
```

Requirements:

- `run.meta` is the first event.
- `run.final` is the last event.
- If the client disconnects, the stream may end early; the run must still complete and persist
  (§9.4).

Implementation notes (non-normative; OpenAI Responses streaming):

- Text deltas typically come from `response.output_text.delta` / `response.output_text.done`.
- Function call tool events typically come from:
  - `response.output_item.added` where `item.type === "function_call"` → `tool.call.started`
  - `response.function_call_arguments.delta` → `tool.call.arguments.delta`
  - `response.output_item.done` → `tool.call.arguments.done` + `tool.call.status: completed`
- Provider tools (OpenAI-hosted) typically appear as output items whose `item.type` ends in `_call`
  (best-effort). The fragment should emit `tool.call.started` and `tool.call.status` and may emit
  `tool.call.output` when a useful result payload is available.

## 12. Client Bindings

The fragment should expose typed client helpers similar to other fragments:

- `useThreads()` / `createThread()` / `useMessages(threadId)` etc.
- `startRunStream(threadId, ...)` that consumes NDJSON stream and updates UI state
- `getRun(runId)` and `subscribeRunEvents(runId)` for resumability

## 13. Security Considerations

- v0.1 has **no built-in access control**. Host apps can add auth at the edge/reverse-proxy or by
  wrapping fragment routes.
- Host apps should protect `POST /ai/_runner/tick` from public access.
- All routes enforce thread scoping (`threadId`) for correctness (not as a security boundary in
  v0.1).
- Webhook route must:
  - verify signature
  - not expose the shared secret
  - be rate-limited
- v0.1 uses **provider tools only**, so the server does not execute arbitrary tool code.
- Future custom tools are a high-risk surface and require a permission model and/or sandboxing.

## 14. Observability

Persisted data supports:

- per-run cost and token usage (via pi-ai usage fields)
- per-tool execution timings
- audit trail for webhooks and runner actions

## 15. Developer Tooling (future)

Add a small CLI app (`apps/fragno-ai`) for debugging the AI fragment via its HTTP routes:

- List/get threads
- Inspect a thread’s messages and runs
- Inspect run artifacts and (optionally) persisted run events
- Support human-readable output by default and `--json` for scripting

## 16. Decisions (v0.6)

- Default tool config: **no tools enabled** unless `ai_thread.openaiToolConfig` is set.
- Deep research artifact payload: `rawResponse` is persisted only when
  `config.storage.persistOpenAIRawResponses === true` (default: `false`).
