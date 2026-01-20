# Fragno AI Fragment — Implementation Plan (Draft)

This plan implements `specs/ai-fragment-spec.md` (Draft v0.6): durable threads, durable runs,
OpenAI-only execution, NDJSON streaming, deep research background + webhooks, and a tick-based
runner modeled after the Workflows fragment (no workflow integration in v0.1).

## Phase 0 — Lock decisions + spikes (0.5–2 days)

**Goal:** validate the risky bits early (streaming, webhook verification, persistence boundaries).

1. [x] Confirm v0.1 scope (already decided):
   - [x] OpenAI-only
   - [x] provider tools only (OpenAI-hosted tools; no server-executed custom tools)
   - [x] no access control (host can protect endpoints externally)
   - [x] message append and run creation are separate
   - [x] append-only messages
   - [x] deep research produces an artifact + an assistant message referencing it
   - [x] per-thread tool config is pass-through JSON
2. [x] Lock interview decisions (already decided):
   - [x] Name + docs path: **Fragno AI** at `/docs/ai` with landing-page tile
   - [x] Webhooks are server-only (no client hooks)
   - [x] No client hook for runner tick
   - [x] All user-facing routes get hooks/mutators + invalidation
   - [x] Example app uses React Router + Drizzle + PGLite
   - [x] Example app: open endpoints, no runner tick controls, 1s polling, simple thread list
   - [x] Example app layout: homepage + threads view (list + detail)
   - [x] CLI auth mirrors Workflows (repeatable headers; no fixed auth scheme)
   - [x] `apiKey` optional if `getApiKey` provided (at least one required)
   - [x] `enableRunnerTick` default false
   - [x] CLI covers full non-webhook HTTP surface (threads/messages/runs/events/artifacts + stream)
3. [x] Spike: NDJSON streaming route using OpenAI Responses (copy the `jsonStream` pattern from
       `example-fragments/chatno/src/server/chatno-api.ts`)
   - [x] verify disconnect behavior: client cancel should not crash the handler
4. [x] Spike: webhook verification using `openai.webhooks.unwrap(...)` with a single configured
       secret
   - [x] confirm runtime has `globalThis.crypto` (Node >= 22)
5. [x] Spike: persistence boundaries:
   - [x] deltas transient by default
   - [x] confirm we can persist final assistant message even if the client disconnects mid-stream
   - [x] confirm `config.storage.persistOpenAIRawResponses` default `false` behaves as expected
         (report-only artifacts)
6. [ ] Align fragment config with pi (see `/Users/wilco/dev/pi-mono`):
   - [x] mirror pi-ai `SimpleStreamOptions` + OpenAI Responses options in `AiFragmentConfig`
   - [x] mirror pi-agent `thinkingLevel` + `thinkingBudgets`
   - [x] update docs examples accordingly
7. [ ] Spike: shared dispatcher generalization
   - [x] extract `createInProcessDispatcher` into a generic package (node) and update all
         Workflows/AI call sites to use it directly (no shims; update call sites directly)
   - [ ] prototype a generic Cloudflare DO dispatcher runtime by extracting the core loop from
         `@fragno-dev/workflows-dispatcher-cloudflare-do`
   - [ ] validate AI scheduling inputs (earliest `ai_run.nextAttemptAt` + unprocessed webhooks)
   - [ ] update Workflows dispatcher wrappers to use the shared runtime and fix any breakages

Deliverables:

- [x] Updated spec/plan (this repo’s `specs/`)
- [ ] A small scratch fragment or test route proving NDJSON + webhook verification (optional)

## Phase 1 — Package skeleton + DB schema (2–4 days)

1. [x] Create new workspace package:
   - [x] `packages/fragment-ai` (name: `@fragno-dev/fragment-ai`)
2. [ ] Add dependencies:
   - [x] `@fragno-dev/core`, `@fragno-dev/db`
   - [x] `openai` (Responses API + webhook verification)
   - [ ] (optional, v0.2+): `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`
3. [x] Implement schema in `packages/fragment-ai/src/schema.ts`:
   - [x] `ai_thread`
   - [x] `ai_message`
   - [x] `ai_run` (includes `executionMode`, `attempt/maxAttempts/nextAttemptAt`,
         `openaiResponseId`)
   - [x] `ai_run_event` (coarse timeline; deltas optional)
   - [x] `ai_artifact` (deep research structured artifacts)
   - [x] `ai_openai_webhook_event` (idempotency + audit)
   - [x] (optional stub for v0.2+): `ai_tool_call`
4. [x] Implement services in `packages/fragment-ai/src/services/*`:
   - [x] `threadsService` (CRUD; includes per-thread `openaiToolConfig`)
   - [x] `messagesService` (append + list by `threadId`)
   - [x] `runsService` (create/cancel/get; selects input message; snapshots config)
     - [x] snapshot thread `openaiToolConfig` into `ai_run` at creation time
   - [x] `artifactsService` (list/get by runId/artifactId)
   - [x] `webhooksService` (persist deliveries; idempotency by `openaiEventId`)
   - [x] `runnerRepo` helpers:
     - [x] claim next runnable `ai_run` rows (queued + due retries)
     - [x] claim next unprocessed webhook events
5. [x] Implement fragment definition:
   - [x] `packages/fragment-ai/src/index.ts` exporting `aiDefinition`
   - [x] `withDatabase(aiSchema)` and `provideHooks` for `dispatcher.wake` notifications

Validation:

- [x] Add basic service-level tests for create/list of threads/messages/runs
- [x] Add an idempotency test for `ai_openai_webhook_event` unique constraint behavior

## Phase 2 — HTTP routes + typed clients (2–5 days)

**Goal:** ship a complete API surface before adding execution complexity.

1. [x] Implement routes in `packages/fragment-ai/src/server/routes.ts` (or repo convention):
   - [x] Threads:
     - [x] `POST /ai/threads`
     - [x] `GET /ai/threads`
     - [x] `GET/PATCH /ai/threads/:threadId`
     - [x] `DELETE /ai/admin/threads/:threadId` (admin-only; host-protect)
   - [x] Messages:
     - [x] `POST /ai/threads/:threadId/messages`
     - [x] `GET /ai/threads/:threadId/messages`
   - [x] Runs:
     - [x] `POST /ai/threads/:threadId/runs` (background by default)
     - [x] `POST /ai/threads/:threadId/runs:stream` (foreground stream)
     - [x] `GET /ai/threads/:threadId/runs`
     - [x] `GET /ai/runs/:runId`
     - [x] `POST /ai/runs/:runId/cancel`
     - [x] `GET /ai/runs/:runId/events` (persisted replay)
   - [x] Artifacts:
     - [x] `GET /ai/runs/:runId/artifacts`
     - [x] `GET /ai/artifacts/:artifactId`
   - [x] Webhooks:
     - [x] `POST /ai/webhooks/openai`
   - [x] Runner:
     - [x] `POST /ai/_runner/tick`
     - [x] only mount when `enableRunnerTick === true` (default false)
2. [x] Define zod schemas for each route input/output and the NDJSON stream event union.
3. [x] Add typed client bindings:
   - [x] `packages/fragment-ai/src/client/*` per Fragno conventions
   - [x] helper for NDJSON consumption (mirror existing Fragno client patterns)
   - [x] use `createClientBuilder` to expose hooks:
     - [x] `useThreads`, `useThread`, `useMessages`, `useRuns`, `useRun`, `useRunEvents`
     - [x] `useArtifacts`, `useArtifact`
     - [x] `useCreateThread`, `useUpdateThread`, `useDeleteThread`
     - [x] `useAppendMessage`, `useCreateRun`, `useCancelRun`
     - [x] `useRunStream` / `startRunStream` (stream state helper via `createMutator`)
     - [x] derived stores for stream text/status + debug event buffers via `builder.createStore`
   - [x] implement invalidation rules per spec:
     - [x] `useCreateThread` → invalidate `GET /ai/threads`
     - [x] `useUpdateThread` → invalidate `GET /ai/threads/:threadId` + `GET /ai/threads`
     - [x] `useDeleteThread` → invalidate `GET /ai/threads/:threadId` + `GET /ai/threads`
     - [x] `useAppendMessage` → invalidate `GET /ai/threads/:threadId/messages` + `GET /ai/threads`
     - [x] `useCreateRun` → invalidate `GET /ai/threads/:threadId/runs`
   - [x] `useRunStream` → invalidate `GET /ai/threads/:threadId/runs` +
         `GET /ai/threads/:threadId/messages` on completion
     - [x] `useCancelRun` → invalidate `GET /ai/runs/:runId` + `GET /ai/runs/:runId/events`

Validation:

- [x] Minimal E2E tests (create thread → append message → create run; list artifacts)

## Phase 3 — OpenAI execution engine (agent runs) (3–7 days)

**Goal:** execute agent runs end-to-end in both foreground-stream and background modes.

1. [x] Implement `runExecutor` service:
   - [x] input: `{ runId }`
   - [x] loads run + thread + message history
   - [x] constructs OpenAI Responses input (system prompt + history)
   - [x] uses OpenAI idempotency keys derived from `(runId, attempt)` for `responses.create(...)`
2. [x] Foreground streaming (`runs:stream`):
   - [x] create `ai_run` with `executionMode="foreground_stream"` and mark `running`
   - [x] call `openai.responses.create({ stream: true, ... })`
   - [x] map OpenAI streaming events into a simplified NDJSON schema for the frontend (text + tool
         lifecycle):
     - [x] `run.meta` first
     - [x] `output.text.delta` / `output.text.done`
     - [x] `tool.call.*` events (status + args deltas when available)
     - [x] `run.final` last
   - [x] persist:
     - [x] `ai_run.openaiResponseId` as soon as it is known
     - [x] final assistant message(s)
     - [x] final run status + run events
3. [x] Background agent runs (`executionMode="background"`):
   - [x] runner tick claims queued runs and calls `runExecutor`
   - [x] prefer `stream: false` for atomic completion (simplifies retries)
4. [ ] Disconnect handling:
   - [x] client disconnect must not cancel the OpenAI request by default
   - [ ] if the upstream OpenAI stream breaks:
     - [x] if `openaiResponseId` is known, retrieve + finalize in the stream handler
     - [x] else schedule a retry via `attempt/maxAttempts/nextAttemptAt`
5. [x] Cancellation (best-effort, in-process):
   - [x] `POST /ai/runs/:runId/cancel` marks `cancelled`
   - [x] if the run is currently executing in-process, abort via `AbortController`

Validation:

- [x] tests for:
  - [x] foreground stream returns NDJSON events and persists final message
  - [x] client disconnect does not prevent final persistence (simulate by canceling reader)
  - [x] stream failure after response id recovers via retrieve
  - [x] provider disconnect without response id schedules retry or fails deterministically
  - [x] background run completes via runner tick

## Phase 4 — Runner tick (in-process) (2–5 days)

**Goal:** unify all async processing behind a safe, bounded `tick`.

1. [x] Implement runner core:
   - [x] `processTick({ maxRuns, maxWebhookEvents })`
   - [x] safe under concurrency (multiple tick callers)
   - [x] claims work using optimistic concurrency control (no leases/locks):
     - [x] load candidate work items
     - [x] update the row with a version check (`.check()`), and treat conflicts as “someone else
           got it”
2. [ ] Work types:
   - [x] agent run (background): execute via `runExecutor`
   - [x] deep research run (queued): submit background Response (Phase 5)
   - [x] webhook event: retrieve response + finalize (Phase 5)
3. [ ] Wake-ups:
   - [x] on run creation and webhook receipt, enqueue a durable hook payload (`AiWakeEvent`) after
         DB commit
   - [x] durable hook handler calls `config.dispatcher?.wake(...)` (or directly triggers
         `POST /ai/_runner/tick`)
   - [x] wake-ups are an accelerator; HTTP tick is fallback for manual/cron recovery only (when
         enabled)
   - [x] wake dispatcher when a foreground stream retry queues a run
4. [ ] Bounded work:
   - [x] ensure each tick respects limits and returns counts (`processedRuns`,
         `processedWebhookEvents`)
5. [ ] Dispatcher integrations:
   - [x] Node: use the shared dispatcher (`@fragno-dev/dispatcher-node`) and wire wake to
         `POST /ai/_runner/tick` or `runner.tick(...)`
   - [x] Cloudflare DO: create a shared dispatcher runtime package (e.g.
         `@fragno-dev/dispatcher-cloudflare-do`) by extracting core logic from the workflows DO
         package (keep tick coalescing + alarm scheduling behavior)
   - [x] Introduce a shared `FragnoDispatcher` interface (core/shared package) and alias it in
         Workflows + AI configs
   - [ ] Add an AI wrapper (e.g. `createAiDispatcherDurableObject`) in
         `@fragno-dev/ai-dispatcher-cloudflare-do` that uses AI schema + runner and schedules alarms
         based on `ai_run.nextAttemptAt` + unprocessed webhook events (same pattern as workflows DO)
   - [ ] Match Workflows DO options where applicable (`namespace`, `runnerId`, `tickOptions`,
         `enableRunnerTick`, `migrateOnStartup`, `createAdapter`, `onTickError`, `onMigrationError`)
   - [x] Update `@fragno-dev/workflows-dispatcher-cloudflare-do` to wrap the shared runtime directly
         (no shim layer)
   - [ ] Update workflows docs/examples to use `@fragno-dev/dispatcher-node` and the refactored DO
         dispatcher packages (e.g. runner-dispatcher docs + quickstart snippets)

Validation:

- [x] concurrency test: two ticks racing should not double-process the same run/event
- [x] “poison pill” test: repeated failures should back off using `nextAttemptAt`

## Phase 5 — Deep research + webhooks + artifacts (3–8 days)

**Goal:** deep research as a durable background job with webhook completion.

1. [x] Run submission (runner side):
   - [x] for `type="deep_research"` queued runs:
     - [x] call `openai.responses.create({ background: true, ... })`
     - [x] set `idempotencyKey` based on `(runId, attempt)`
     - [x] persist `openaiResponseId` and set status `waiting_webhook`
2. [x] Webhook route:
   - [x] verify signature with the single `config.openaiWebhookSecret`
   - [x] persist event idempotently (`openaiEventId` unique)
   - [x] store `responseId` and associate to run when possible
   - [x] enqueue a durable hook wake-up after commit so processing runs later with retries
   - [x] do not fetch from OpenAI inside the webhook route (keep it fast + reliable)
3. [x] Completion processing (runner side):
   - [x] claim unprocessed webhook events
   - [x] retrieve the full Response from OpenAI by `responseId`
   - [x] create `ai_artifact` with `type="deep_research_report"`:
     - [x] `data` contains the structured report payload (Markdown + sources + metadata)
     - [x] include `rawResponse` only when `config.storage.persistOpenAIRawResponses === true`
           (default: false)
   - [x] append an assistant `ai_message` to the thread: `{ type: "artifactRef", artifactId }`
   - [x] mark run `succeeded`/`failed`, set `completedAt`
   - [x] mark webhook event `processedAt`
4. [x] Edge cases:

- [x] webhook arrives before run persists `openaiResponseId`: event persists anyway; runner will
      match later using `responseId`
- [x] runner skips OpenAI retrieval until a webhook event can be matched to a run
- [x] OpenAI retrieve fails transiently: keep `processedAt=null`, set `processingError`, back off

Validation:

- [x] idempotency tests: duplicate webhook deliveries do not create duplicate artifacts or
      re-complete runs
- [x] end-to-end: create deep research run → submit → webhook → artifact persisted

## Phase 6 — Hardening + future work (ongoing)

v0.1 hardening:

- [ ] Limits:
  - [x] max message size
  - [x] max artifact size
  - [x] page size caps in services
- [x] Rate limits at host level for webhooks + tick endpoint
- [x] Observability: structured logs for run lifecycle + webhook processing
- [x] Admin-only debug/delete routes (host-protect)

Future (v0.2+):

- [ ] Custom tools registry + server execution (pi-agent-core integration)
- [ ] Tool approvals/policy hooks
- [ ] Multi-provider support (pi-ai)
- [ ] Conversation compaction/summarization (borrow pi-coding-agent patterns)
- [ ] External artifact storage (blob store) with DB references

## Phase 7 — CLI tool: `fragno-ai` (0.5–2 days)

**Goal:** easy debugging of AI fragment state via HTTP routes.

1. [ ] Add new workspace app: `apps/fragno-ai` with binary `fragno-ai`.
2. [ ] Implement `threads` commands:
   - [ ] `fragno-ai threads list --base-url <url>`
   - [ ] `fragno-ai threads get <threadId> --base-url <url>`
   - [ ] `fragno-ai threads create --base-url <url> [--title ...] [--system-prompt ...]`
   - [ ] `fragno-ai threads update <threadId> --base-url <url> [--title ...] [--system-prompt ...]`
   - [ ] `fragno-ai threads delete <threadId> --base-url <url>` (admin route)
3. [ ] Implement `messages` commands:
   - [ ] `fragno-ai messages list --thread <threadId> --base-url <url>`
   - [ ] `fragno-ai messages append --thread <threadId> --content <text|json>`
4. [ ] Implement `runs` commands:
   - [ ] `fragno-ai runs list --thread <threadId> --base-url <url>`
   - [ ] `fragno-ai runs get <runId> --base-url <url>`
   - [ ] `fragno-ai runs create --thread <threadId> [--type agent|deep_research] [--mode background|stream]`
   - [ ] `fragno-ai runs stream --thread <threadId>` (prints NDJSON)
   - [ ] `fragno-ai runs cancel <runId> --base-url <url>`
   - [ ] `fragno-ai runs events <runId> --base-url <url>`
5. [ ] Implement `artifacts` commands:
   - [ ] `fragno-ai artifacts list --run <runId> --base-url <url>`
   - [ ] `fragno-ai artifacts get <artifactId> --base-url <url>`
6. [ ] Keep output human-friendly by default (table-ish), with `--json` for scripting.
7. [ ] Auth support (same flexibility as Workflows spec):
   - [ ] repeatable `-H/--header "Header: Value"` passthrough headers

## Phase 8 — Documentation (1–3 days)

**Goal:** ship full docs + landing page tile for the AI fragment.

1. [ ] Add **Fragno AI** tile to docs landing page:
   - [ ] `apps/docs/app/routes/docs/docs-index.tsx` (route `/docs/ai`)
2. [ ] Add AI fragment docs:
   - [ ] create `apps/docs/content/docs/ai`
   - [ ] add `meta.json` sidebar config
   - [ ] add pages: `index`, `quickstart`, `configuration`, `routes`, `hooks`, `streaming`, `runs`,
         `webhooks`, `runner`, `artifacts`, `cli`, `debugging`, `example-app`
3. [ ] Ensure hooks + invalidation are documented in the hooks page.
4. [ ] Document Node + Cloudflare DO dispatchers in the runner page, mirroring
       `apps/docs/content/docs/workflows/runner-dispatcher.mdx` structure and examples.
5. [ ] Document CLI usage in the CLI page, mirroring `apps/docs/content/docs/workflows/cli.mdx`.
6. [ ] Document that the example app uses open endpoints and is for debugging only.

Validation:

- [ ] Docs build passes (local or CI)

## Phase 9 — Example app (React Router + Drizzle + PGLite) (2–5 days)

**Goal:** provide a clean, debug-friendly UI that exercises all hooks.

1. [ ] Create `example-apps/ai-fragment-react-router-drizzle` (copy react-router example skeleton).
2. [ ] Use Drizzle + PGLite for local persistence.
3. [ ] Implement pages:
   - [ ] Home page (intro, quick actions)
   - [ ] Threads view with left list (simple list, no pagination) + right detail view (thread +
         messages + runs)
4. [ ] Wire all hooks/mutators/stream helpers from §12:
   - [ ] thread CRUD + messages + runs + run events + artifacts
   - [ ] live stream panel + persisted run events panel (event buffer: 200)
   - [ ] deep research flow (background) + artifact display
5. [ ] Keep endpoints open (no auth) and do not add runner tick controls.
6. [ ] Add timer-based refresh for background runs/messages (1s polling).

Validation:

- [ ] Manual flows: create thread → append message → stream run → background run → deep research
- [ ] View persisted messages, runs, run events, artifacts

## Interview: Remaining Gaps / Decisions

- [x] `apiKey` optional if `getApiKey` is provided (at least one required).
- [x] `enableRunnerTick` defaults to false.
- [x] CLI commands cover threads, messages, runs, run events, artifacts, and streaming.
