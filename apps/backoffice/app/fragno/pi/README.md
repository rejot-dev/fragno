# Durable Pi

Backoffice Pi runs a finite set of defined **agents** per scope. Each agent is one durable `PI`
object with one ongoing root conversation, compacted automatically, that runs one turn at a time.

- `workers/pi-manager.do.ts`: one `PI_MANAGER` object per execution scope, with the same singleton,
  organization, user, and project scopes as Automations. Use `objects.piManager.for(scope)` or its
  `singleton`, `forOrg`, and `forUser` selectors. Its embedded Fragno fragment stores agent
  definitions and records which agents have been provisioned, with their billing owner.
- `workers/pi.do.ts`: one `PI` object per agent, addressed by `piAgentObjectName` from its scope and
  agent name.
- `workers/lib/pi-session-store.ts`: Cloudflare SQLite implementation of Pi Durable's
  `SqliteDatabase` contract. Pi owns transcripts, submissions, documents, and tasks in `pi_*`
  tables.

`workers/` holds only Cloudflare-specific code. Everything that also runs locally lives here,
organized around Pi Durable:

- `agent/`: one Pi Durable `Harness` per agent. `agent-definitions.ts` holds the built-in
  definitions and reads instructions. `pi-agent-turns.ts` records each turn's authority.
  `pi-agent-harness.ts` is the only place a `Registry` is built; it installs the runtime's
  `PiAgentDependencies.extensions`, then the Backoffice extensions, then workspace extensions. A
  later extension's same-name tool wins. `backoffice-agent-context.ts` rebuilds execution authority
  and tool runtimes for the turn that owns the agent's current work; extensions receive it as their
  only Backoffice collaborator.
- `extensions/`: everything installed into the registry. `backoffice/` (guidance and agent
  instruction sections, and the `read`, `search`, and `execCodeMode` tools), `billing/` (usage
  delivery task and document), `posthog/` (generation analytics, production Cloudflare only), and
  `workspace/` (author-built extensions from `/workspace/pi/extensions.json`, run inside sealed
  codemode guests).
- `manager/`: the scoped agent directory fragment and the runtime that runtime tools and codemode
  use to call it.

## Agent definitions

A scope's agents are rows in the manager's `agent_definition` table, keyed by agent name, plus the
built-in `assistant` defined in `agent/agent-definitions.ts`, whose name a scope cannot take. A
definition holds a `description`, a `provider/modelId` `model` or null for the first available
model, at least one permission grant (`*`, which narrows nothing, `namespace.*`, or catalog
entries), Markdown `instructions`, and the `managedBy` marker packages use to claim their agents, as
they do routes. `pi.agent.create`, `pi.agent.update`, and `pi.agent.delete` change definitions and
require `pi.manage`, so only they can change what an agent is told; input is validated on write, so
the directory holds no unusable definitions. Deleting a definition keeps the `agent` provisioning
row and its conversation.

Each admission reads the definition and renders its instructions as the `agent` prompt section after
Backoffice guidance and a one-line `identity` section naming the agent, so changes apply from the
next turn. Grants are expanded at admission, so a grant whose permissions were removed from the
catalog grants nothing.

## Turn authority

A turn runs as whoever prompted it. The manager middleware captures the submitter's actors and scope
restriction, never their temporary request authority, and the handler adds the definition's model,
instructions, and permissions as read at admission. The agent object records this turn in the
session-scoped `backoffice.pi.turns` document, keyed by request id, before admitting the prompt.

Every authorization goes through the turn's execution: the submitter's actors with
`{ type: "pi-agent", id: "<scope segment>/<name>", role: "assistant" }` appended as a delegate,
identified by scope because agents of different scopes share names, whose capability grants are the
definition's permissions, bound with `withBackofficeActorCapabilityGrants` for that turn. Because
the kernel requires the principal and every delegate to grant an operation, a definition can only
narrow the submitter, so editing a definition never escalates. Running a turn itself (`pi.modify`,
and billing access for user and system scopes) is checked with the submitter's actors alone, so
definitions need not grant it. Deferred executions re-resolve permissions on every check, so
revocations apply mid-turn.

The root conversation's current run (`pi.live` `run.inputs[0]`) identifies the owning turn. Pi's
model boundary has no conversation context, which is sound because the root conversation is the
agent's only conversation and runs one turn at a time. Work outside any run, such as background or
manual compaction, uses the latest admitted turn; manual compaction records its requester first. A
turn is recorded before Pi admits its prompt, so no work can start without it, and withdrawn if Pi
does not admit it, so a refused prompt never decides whom later work runs as. Work a turn persists,
such as workflows or events, keeps the `pi-agent` actor, whose static role grants everything: it
runs as the principal without the definition's narrowing.

## Queue

The manager logs every prompt an agent receives in its `agent_queue_item` table, and Pi only ever
receives a steer or the one item the queue dispatched. An item is `queued`, `dispatched` (the turn
Pi runs), `steered` (joined that turn), `settled`, or `dropped`. Items stay after they end, so a
resent request ID keeps its first placement and never runs twice; nothing prunes the log yet.

- `steer` joins the dispatched turn when that turn has the same actors and scope restriction.
  Otherwise the prompt is queued like `followUp`, the default. The receipt's `status` says `steered`
  or `queued`.
- `reject` is refused with `409 AGENT_BUSY` while an item is dispatched.
- With nothing dispatched, a new prompt is dispatched at once; items wait only behind a dispatched
  one.

Each change is one retrieve and one mutation, then at most one call to the agent object. The
mutation decides: it admits the prompt against the agent's definition and models as they are then,
provisions the agent on its first prompt, and records the placement. Every change bumps the agent
row's `queueRevision` with an optimistic check, so concurrent changes to one queue conflict and
retry, and a new item takes that revision as its position. The agent's settled-turn outbox (see Turn
events) reports every settled turn through the manager object's `reportSettledTurn` command, whose
mutation settles the item and dispatches the next one, admitted against the definition as it is
then. When the definition or model it needs is gone, every waiting item is dropped with the reason,
since admission does not depend on the item.

Items are recorded before the agent receives them. Each handover also triggers the
`redispatchAgentQueue` durable hook, which hands every unsettled dispatched or steered item over
again; Pi keeps the submission of a request ID it already has. A steer that reaches the agent after
its turn ended runs as a follow-up instead of joining another authority's turn.

A prompt's submission reads `{ type: "input", status: "queued", requestId }` until Pi has it, and
`{ type: "input", status: "dropped", requestId, reason }` once dropped; waiting for a queued prompt
also waits for its dispatch, and `pi.runPrompt` fails with `PI_MANAGER_PROMPT_DROPPED`. Aborting
drops the queued items and withdraws what Pi holds. Notifications do not go through the queue yet.

## Turn events

Every answered prompt records one `pi` Automations event in the agent's scope, `turn.completed` with
the answer's entry ID. Prompts that settle unanswered, such as aborted, withdrawn, or failed ones,
record nothing. A steer that joined a running turn settles with that turn. The event's subject names
the agent and the prompt's request ID, its actors are the turn's execution actors, and its scope
restriction is the turn's. It carries no answer text; `pi.getSubmission` leads to the answer.

Pi settles submissions in its own commits, so the turns document is the outbox: a settled turn stays
in `pending` until its event, if any, is ingested, keyed `pi:<agentName>:<requestId>`, and its
manager is told, and then forgotten. Neither report waits on the other, so an unrecordable event
never holds back the agent's queue. A commit listener reports each settlement as it happens, and the
alarm reports again after the agent goes idle, keeping its heartbeat until every settled turn is
recorded. Runtimes without Automations forget settled turns without recording them.

## Notifications

A `notify_agent` Automations route delivers an event to an agent of the route's scope through
`POST /agents/:agentName/notifications`. A workflow an agent starts with `execCodeMode` replies
through the same route, with no route ID and the run's execution: when the run ends, Automations
notifies the agent with a `workflows` `instance.completed` event carrying its status, output, and
error. The workflows middleware accepts a codemode run's `replyTo` agent only from that agent's own
turn, which it recognizes by the agent's delegate actor. The agent object writes the event into the
root conversation as a `backoffice.notification` entry, whose data is the route ID and event and
whose model message is one `<backoffice-event>` element: the event's identity as attributes, its
subject and payload as JSON whose `<` is escaped, so event data cannot close the element. Backoffice
guidance tells agents to treat it as data. Users only submit inputs, which Pi writes as `pi.user`,
so the chat's event card cannot be forged.

Pi places a write at a busy conversation's next boundary, tool rounds included, so a running turn
can see and act on an event with its own submitter's authority. The agent then submits a follow-up
input, one `<backoffice-notifications-request>` element listing each notification by its route, if
any, and event ID, as a turn run with the route's or the workflow run's execution. A queued input
cannot change, so when a follow-up posted with the same actors and scope restriction is still
queued, the agent withdraws it and posts one listing both its notifications and the new one; if Pi
placed it first, the new follow-up lists only the new notification. A withdrawn follow-up settles
unanswered and records no turn event. `backoffice.pi.notifications` records the queued follow-ups
and what they list, and notifications run one at a time per agent object. The chat shows a follow-up
as a "Handling N notifications" divider below their cards, and the composer queue labels it the same
way; a typed request only restyles the typist's own message.

Request IDs make redelivery idempotent: the write is `route:<routeId>:<eventId>:event`, or
`reply:<eventId>:event` without a route, and a follow-up takes the write's ID without `:event` for
the newest notification it lists, which is also the request ID its `turn.completed` reports. A
redelivered notification that a queued follow-up already lists posts nothing. An object restart
between withdrawing a follow-up and posting its replacement leaves the withdrawn notifications
unlisted; their entries stay in the conversation. Notifications never provision an agent, because a
personal agent's billing owner is chosen by its first prompter: an agent with no turns answers
`404 AGENT_NOT_STARTED`. Everything an agent's turns produce, including its `pi` events and any
event reclassified or forwarded from them, keeps the agent's actor among its delegates, and a route
never delivers such an event to that agent.

## Manager routes

All paths below are mounted at `/api/pi-manager` inside the manager object:

- `GET /models`: the `PI_SUPPORTED_MODELS` entries whose provider credentials are available from the
  same registry used by agents, with each model's context window from that registry.
- `GET /agents`: every definition with its provisioning (`null` until its first turn), and invalid
  definitions.
- `GET /agents/:agentName`: one definition and its provisioning.
- `POST /agents/:agentName/prompts`: `{ requestId, content, whenBusy, billingOrganizationId }`,
  answering `{ requestId, status }` or `409 AGENT_BUSY` for a refused `reject`; see Queue. The first
  prompt provisions the agent: organization and project agents bill their organization, user agents
  require an authorized billing organization, and later turns keep the original owner. Reusing a
  request ID reuses the submission rather than generating another answer.
- `POST /agents/:agentName/notifications`: `{ routeId, event }`, answering `204` or
  `404 AGENT_NOT_STARTED`. Automations routes and workflow replies, whose `routeId` is `null`, call
  it; see Notifications.
- `GET /agents/:agentName/submissions/:requestId`: Pi's submission record, or the queue's record of
  a prompt Pi does not have; see Queue.
- `GET /agents/:agentName/submissions/:requestId/wait?waitMs=...`: bounded, commit-driven wait for a
  queued prompt's dispatch and its submission's settlement.
- `GET /agents/:agentName/view`: Pi's committed active structural conversation view.
- `GET /agents/:agentName/entries?cursor=...&pageSize=...`: newest-first, fork-aware durable entry
  history (maximum 256 entries per page).
- `GET /agents/:agentName/export`: streaming versioned JSONL export over every durable entry.
- `POST /agents/:agentName/compact`: admits manual durable compaction with optional instructions.
- `GET /agents/:agentName/compactions/:taskId`: public running/completed/failed compaction state.
- `POST /agents/:agentName/abort`: aborts the agent's current work, including background work.

Conversation routes return `404 AGENT_NOT_STARTED` before an agent's first turn. A damaged Chord
document path returns `409 PI_CONVERSATION_VIEW_DAMAGED` from the view and stream routes instead of
presenting an entry-only view as an idle conversation. Durable entry history and JSONL export remain
independent read paths.

Manager HTTP requests must use `http.fetchAuthorized` with a matching execution scope. The manager
verifies the signed object address and enforces the existing `pi.read` / `pi.modify` permissions.

The agent persists an alarm before admitting input. Alarm invocations resume Pi's own scheduler,
retain a recovery heartbeat while work remains, and clear the alarm when the agent is idle. There is
no Fragno workflow involved in agent execution. The same manager and agent lifecycle runs in
Cloudflare and local/Node runtimes. Local agents use Pi Durable's Node SQLite adapter: in-memory
SQLite for transient scenarios, or one `pi-agent-*.sqlite` file per agent in the configured SQLite
data directory.

## Workspace extensions

Workspace extensions load with the authority of the turn being admitted, and again whenever the
manifest or a listed artifact's size or modification time changed since the last load. A turn keeps
the extensions it started with. After a restart, an agent with a recorded turn reloads them before
resuming work.

## Backoffice execution

`extensions/backoffice/backoffice-extension.ts` installs the shared Backoffice `read`, `search`, and
`execCodeMode` implementations. They use the scoped filesystem, route-backed service runtimes,
existing codemode execution environment, and kernel permission checks of the active turn.
Authorization does not rely on prompt sections or extension environment hooks: Pi reports their
errors but continues generation, so the model boundary and every tool check fail closed.

Pi tool calls inherit the agent's billing organization when a prompt omits `billingOrganizationId`.
Inline codemode workflows snapshot the turn's execution and billing selection in their execution
metadata and restore them after suspension, retries, and object restarts. Saved workflows started
from these contexts inherit the same selection, including nested workflows.

Runtime tools target the scoped manager directly: `pi.listAgents`, `pi.getAgent`, `pi.submitPrompt`,
`pi.getSubmission`, `pi.runPrompt`, and `pi.abortAgent`. Scoped context handles rebuild this runtime
for the selected scope. Synchronous prompt execution uses Pi Durable's commit-driven submission
waiter through a bounded long-poll request. Prompt request IDs are stable within durable tool
invocations; timeout or caller cancellation stops the wait but does not retract already admitted
work. Manager failures throw `PiManagerRuntimeRequestError` with stable `status` and `code` fields,
which codemode preserves for workflow recovery decisions.

## Backoffice agents UI

The agent route loaders and actions call the scoped manager through `http.fetchAuthorized` and the
Fragno route contract. The UI lists defined agents and where each comes from, starts an agent's
conversation with its first message (choosing the active organization as a personal agent's billing
owner), steers the sender's own running turn and queues messages otherwise, shows the input Pi holds
in `pi.inbox` in the composer as steering or up next, estimates the active context against the
conversation's model, runs and monitors manual compaction, paginates inactive transcript history,
downloads streaming JSONL exports, and aborts active work. A scoped resource route proxies the
agent's `application/x-ndjson` conversation-view stream to the browser.

## Recovery

`read` and `search` are replay-safe. `execCodeMode` is replay-unsafe: recovery reports an
interrupted call that may have partially run instead of automatically repeating mutations. Prompt
deduplication is not tool-effect deduplication. Scenarios restore a real SQLite snapshot taken after
a codemode mutation and before tool-result settlement, verifying exactly one effect and that the
restored turn record is the recovered tools' authority.

Production registers OpenAI, Anthropic, and Google providers with credentials from Worker bindings
or Node configuration. An agent-scoped billing document and ownerless durable task deliver
cumulative committed model usage to the agent's billing owner with an idempotent outbox event.
