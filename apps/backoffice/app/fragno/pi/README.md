# Durable Pi

Backoffice Pi sessions use the scoped `PI_MANAGER` directory and one durable `PI` object per agent.

- `workers/pi-manager.do.ts`: one `PI_MANAGER` object per execution scope, with the same singleton,
  organization, user, and project scopes as Automations. Use `objects.piManager.for(scope)` or its
  `singleton`, `forOrg`, `forUser`, and `forProject` selectors. Its embedded Fragno fragment stores
  only the session directory and initial agent choices.
- `workers/pi.do.ts`: one `PI` object per agent, addressed by `piAgentObjectName`. For now, each
  directory session has its own agent and uses that agent's root conversation.
- `workers/lib/pi-session-store.ts`: Cloudflare SQLite implementation of Pi Durable's
  `SqliteDatabase` contract. Pi owns transcripts, submissions, documents, and tasks in `pi_*`
  tables.

`workers/` holds only Cloudflare-specific code. Everything that also runs locally lives here,
organized around Pi Durable:

- `agent/`: one Pi Durable `Harness` per session. `pi-agent-harness.ts` is the only place a
  `Registry` is built; it installs the runtime's `PiAgentDependencies.extensions`, then the
  Backoffice extensions, then workspace extensions. A later extension's same-name tool wins.
  `backoffice-agent-context.ts` rebuilds execution authority and tool runtimes from persisted
  provenance; extensions receive it as their only Backoffice collaborator.
- `extensions/`: everything installed into the registry. `backoffice/` (guidance section and the
  `read`, `search`, and `execCodeMode` tools), `billing/` (usage delivery task and document),
  `posthog/` (generation analytics, production Cloudflare only), and `workspace/` (author-built
  extensions from `/workspace/pi/extensions.json`, run inside sealed codemode guests).
- `manager/`: the scoped session directory fragment and the runtime that runtime tools and codemode
  use to call it.

Manager HTTP requests must use `http.fetchAuthorized` with a matching execution scope. The manager
verifies the signed object address and enforces the existing `pi.read` / `pi.modify` permissions. It
looks up session ownership before handing off to an agent; agent RPCs verify their own object
identity as well.

## Manager routes

All paths below are mounted at `/api/pi-manager` inside the manager object:

- `GET /models`: the `PI_SUPPORTED_MODELS` entries whose provider credentials are available from the
  same registry used by agents, with each model's context window from that registry.
- `POST /sessions`:
  `{ requestId?: string, name: string | null, model?: { provider, modelId }, instructions: string, billingOrganizationId: string | null }`.
  Reusing a request ID returns the originally created session; omission generates a fresh ID. An
  omitted model applies the Backoffice preference order to the credential-available catalog, then
  falls back to its first model. Instructions default to an empty string and the billing owner
  defaults to null. Organization/project sessions derive their billing owner from scope; user
  sessions require an authorized billing organization. The manager rejects models absent from the
  current configured catalog before recording the directory entry; agent initialization is lazy on
  its first operation.
- `GET /sessions?cursor=...&pageSize=...`: cursor-paginated directory (maximum 100 entries).
- `GET /sessions/:sessionId`: directory entry.
- `POST /sessions/:sessionId/prompts`: `{ requestId, content, whenBusy }`, where `whenBusy` is
  `steer` (default) or `reject`. Busy sessions place steering input at their next tool boundary;
  there is no follow-up queue. Reusing a request ID reuses the submission rather than generating
  another answer.
- `GET /sessions/:sessionId/submissions/:requestId`: Pi's submission record.
- `GET /sessions/:sessionId/submissions/:requestId/wait?waitMs=...`: bounded, commit-driven wait for
  submission settlement.
- `GET /sessions/:sessionId/view`: Pi's committed active structural conversation view.
- `GET /sessions/:sessionId/entries?cursor=...&pageSize=...`: newest-first, fork-aware durable entry
  history (maximum 256 entries per page).
- `GET /sessions/:sessionId/export`: streaming versioned JSONL export over every durable entry.
- `POST /sessions/:sessionId/compact`: admits manual durable compaction with optional instructions.
- `GET /sessions/:sessionId/compactions/:taskId`: public running/completed/failed compaction state.
- `POST /sessions/:sessionId/abort`: aborts the agent's current work, including background work.

A damaged Chord document path returns `409 PI_CONVERSATION_VIEW_DAMAGED` from the view and stream
routes instead of presenting an entry-only view as an idle conversation. Durable entry history and
JSONL export remain independent read paths.

The agent persists an alarm before admitting input. Alarm invocations resume Pi's own scheduler,
retain a recovery heartbeat while work remains, and clear the alarm when the agent is idle. There is
no Fragno workflow involved in agent execution.

The same manager and agent lifecycle runs in Cloudflare and local/Node runtimes. Local agents use Pi
Durable's Node SQLite adapter: in-memory SQLite for transient scenarios, or one `pi-agent-*.sqlite`
file per agent in the configured SQLite data directory. The local alarm scheduler delivers agent
alarms, and runtime cleanup closes their harnesses and storage. Provisioning includes the full
execution scope, which participates in agent identity and is never taken from the request body.

## Backoffice execution context

The manager persists the authenticated creator's actor provenance and billing ownership alongside
session choices. Caller-supplied actors are overwritten. Temporary JWT/request authority is not
persisted, and the creator is never replaced by a system principal during recovery. Agents rebuild
execution context from these actors and the real runtime/kernel after every cold start. Current
permissions are checked before model requests, including compaction and deferred fetches, and before
tool execution. Authorization does not rely on prompt sections or extension environment hooks: Pi
reports their errors but continues generation.

`extensions/backoffice/backoffice-extension.ts` installs the shared Backoffice `read`, `search`, and
`execCodeMode` implementations. They use the scoped filesystem, route-backed service runtimes,
existing codemode execution environment, and kernel permission checks. Worker codemode still
requires its Worker Loader configuration; local execution uses the existing local executor. System
guidance, codemode declaration guidance, static/workspace skill discovery, session-specific
instructions, and the default thinking level are owned by durable agents.

Pi tool calls inherit the calling session's billing organization when `pi.createSession` omits
`billingOrganizationId`. Inline codemode workflows snapshot this billing selection in their
execution metadata and restore it after suspension, retries, and object restarts. Saved workflows
started from these contexts inherit the same selection, including nested workflows. Organization and
project scopes still derive their billing owner from scope; inheritance never changes execution
scope or actor provenance. Explicit selections for user/system contexts require authorization when
scheduling a workflow and when creating a session, and generation rechecks current access. Selecting
a billing organization does not persist permission to use it.

Runtime tools target the scoped manager directly. They expose durable directory operations,
submission admission and inspection, synchronous prompt execution, and agent cancellation through
`pi.createSession`, `pi.getSession`, `pi.listSessions`, `pi.submitPrompt`, `pi.getSubmission`,
`pi.runPrompt`, and `pi.abortSession`. Scoped context handles rebuild this runtime for the selected
scope. Synchronous prompt execution uses Pi Durable's commit-driven submission waiter through a
bounded long-poll request rather than repeatedly reading submission state. Session creation accepts
a stable `requestId`; replaying it returns the originally created session. Prompt request IDs are
stable within durable tool invocations; timeout or caller cancellation stops the wait but does not
retract already admitted work. Manager failures throw `PiManagerRuntimeRequestError` with stable
`status` and `code` fields, which codemode preserves for workflow recovery decisions.

## Backoffice sessions UI

The session route loaders and actions call the scoped manager through `http.fetchAuthorized` and the
Fragno route contract. The UI lists directory records, creates sessions from the configured model
catalog, admits prompts that steer an active run, shows pending steering input from `pi.inbox` in
the composer, estimates the active context against the model's context window, runs and monitors
manual compaction, paginates inactive transcript history, downloads streaming JSONL exports, and
aborts active work. A scoped resource route proxies the agent's `application/x-ndjson`
conversation-view stream to the browser. The initial snapshot and each committed update replace the
local active view, including throttled `pi.live.generation.message` partials while the model writes.
Historical entries remain separate from active model context and also feed durable codemode
workspace projection. Workflow graph and generated-interface navigation reuse the existing
Automations browser collections and workspace panel. Session URLs use the durable `sessionId`
directly.

## Recovery

`read` and `search` are replay-safe. `execCodeMode` is replay-unsafe: recovery reports an
interrupted call that may have partially run instead of automatically repeating mutations. Prompt
deduplication is not tool-effect deduplication. Scenarios restore a real SQLite snapshot taken after
a codemode mutation and before tool-result settlement, verifying exactly one effect and restored
scoped tools.

Production registers OpenAI, Anthropic, and Google providers with credentials from Worker bindings
or Node configuration. A session-scoped billing document and ownerless durable task deliver
cumulative committed model usage to the persisted billing owner with an idempotent outbox event.
