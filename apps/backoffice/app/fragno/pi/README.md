# Durable Pi

Backoffice Pi runs a finite set of defined **agents** per scope. Each agent is one durable `PI`
object with one ongoing root conversation, compacted automatically, that runs one turn at a time.

- `workers/pi-manager.do.ts`: one `PI_MANAGER` object per execution scope, with the same singleton,
  organization, user, and project scopes as Automations. Use `objects.piManager.for(scope)` or its
  `singleton`, `forOrg`, and `forUser` selectors. Its embedded Fragno fragment stores agent
  definitions and records which agents have been provisioned.
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
  `PiAgentDependencies.extensions`, then the Backoffice extensions. A later extension's same-name
  tool wins. `backoffice-agent-context.ts` rebuilds execution authority and tool runtimes for the
  turn that owns the agent's current work; extensions receive it as their only Backoffice
  collaborator.
- `extensions/`: everything installed into the registry. `backoffice/` (guidance and agent
  instruction sections, and the `read`, `search`, and `execCodeMode` tools), `billing/` (usage
  delivery task and document), and `posthog/` (generation analytics, production Cloudflare only).
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
narrow the submitter, so editing a definition never escalates. Running a turn itself (`pi.modify`)
is checked with the submitter's actors alone, so definitions need not grant it. Deferred executions
re-resolve permissions on every check, so revocations apply mid-turn.

The root conversation's current run (`pi.live` `run.inputs[0]`) identifies the owning turn. Pi's
model boundary has no conversation context, which is sound because the root conversation is the
agent's only conversation and runs one turn at a time. Work outside any run, such as background or
manual compaction, uses the latest admitted turn; manual compaction records its requester first. A
turn is recorded before Pi admits its prompt, so no work can start without it, and withdrawn if Pi
does not admit it, so a refused prompt never decides whom later work runs as. Work a turn persists,
such as workflows or events, keeps the `pi-agent` actor, whose static role grants everything: it
runs as the principal without the definition's narrowing.

## Queue

The manager logs every prompt and notification an agent receives in its `agent_queue_item` table,
and Pi only ever receives a steer or the one turn the queue dispatched. An item is `queued`,
`dispatched` (in the turn Pi runs), `steered` (joined that turn), `settled`, or `dropped`; a
dispatched or settled item names its turn by the turn's Pi request ID. Items stay after they end, so
a resent request ID keeps its first placement and never runs twice; nothing prunes the log yet.

The queue follows six rules. `nextPiAgentQueueTurn` in `pi-agent-queue-rules.ts` applies the first
four, which pick each turn:

1. **Oldest first.** Items are handled in the order they arrived.
2. **One sender per turn.** A turn acts for one sender, so items from different senders run in
   separate turns.
3. **Group notifications.** Notifications waiting from the same sender are handled together in one
   turn.
4. **One prompt per turn.** Each prompt gets its own turn.
5. **Events appear as they arrive.** An event is written into the conversation right away; only the
   request to handle it waits in the queue.
6. **Stopping pauses the queue.** Waiting items stay until someone sends a message or resumes the
   queue.

A sender is a turn's actors and scope restriction, which its authority derives from. So the oldest
item leads the next turn; a prompt runs alone, and a notification takes every waiting notification
from its sender along, even ones behind another sender's items. The turn takes the request ID of the
oldest item it handles.

- `steer` joins the dispatched turn when that turn has the same sender. Otherwise the prompt is
  queued like `followUp`, the default. The receipt's `status` says `steered` or `queued`.
- `reject` is refused with `409 AGENT_BUSY` while a turn is dispatched or items wait.
- With nothing dispatched and the queue running, a new item is dispatched at once; items wait only
  behind a dispatched turn or in a paused queue.
- Stopping an agent (`pi.agent.stop`) pauses its queue and aborts what Pi holds; the stopped turn
  settles unanswered and nothing starts after it. A paused queue records new items but dispatches
  none, even for an idle agent, and a steer never joins the stopped turn.
  `POST /agents/:agentName/resume`, or a prompt with `whenPaused: "resume"`, resumes it: the next
  turn starts at once, or when the stopped turn settles, with the queue's oldest item. The
  Backoffice UI sends `resume`; the default, `wait`, keeps automations and workflows from undoing a
  stop, so `pi.runPrompt` waits until its deadline.

Each change is one retrieve and one mutation, then at most one call to the agent object. The
mutation decides: it admits the item against the agent's definition and models as they are then,
provisions the agent on its first prompt, and records the placement. Every change updates the agent
row with Fragno's optimistic version check, so concurrent changes to one queue conflict and retry,
and a new item takes the row's new version as its position. A concurrent first prompt retries on the
agent row's unique conflict. The agent's settled-turn outbox (see Turn events) reports every settled
turn through the manager object's `reportSettledTurn` command, whose mutation settles every item of
the dispatched turn and dispatches the next one, admitted against the definition as it is then. When
the definition or model it needs is gone, every waiting item is dropped with the reason, since
admission does not depend on the item.

Items are recorded before the agent receives them. Each handover also triggers a durable hook that
repeats it: `redispatchAgentQueue` hands every unsettled dispatched or steered item over again, and
`writeNotificationCards` writes an arrived notification's card again; Pi keeps the submission of a
request ID it already has. A steer that reaches the agent after its turn ended runs as a follow-up
instead of joining another sender's turn.

A request's submission reads `{ type: "input", status: "queued", requestId }` until Pi has its turn,
and `{ type: "input", status: "dropped", requestId, reason }` once dropped; waiting for a queued
prompt also waits for its dispatch, and `pi.runPrompt` fails with `PI_MANAGER_PROMPT_DROPPED`. Once
its turn is dispatched, a request's submission is its turn's, so every notification a turn handled
answers with that turn's submission.

Every change publishes the agent's waiting items and whether its queue is paused, with the agent
row's version as their revision, to the manager object's in-memory queue channel. The view stream
leads with them and sends them again as a `queue` frame whenever they change; an older revision
published late is ignored.

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
turn, which it recognizes by the agent's delegate actor.

A notification is a queue item whose sender is the route's or the workflow run's execution, so the
request to handle it waits its turn like a prompt (see Queue). Its request ID is
`route:<routeId>:<eventId>`, or `reply:<eventId>` without a route, so redelivering an event through
one route, or to the agent directly, places nothing new, even after it was handled. Notifications
never provision an agent: a person must start the conversation first. An agent with no turns answers
`404 AGENT_NOT_STARTED`.

The event itself is written as it arrives, into the root conversation as a `backoffice.notification`
entry with request ID `<requestId>:event`. Pi places a write at a busy conversation's next boundary,
tool rounds included, so a running turn can see and act on an event with its own sender's authority.
When the queue dispatches a turn of notifications, the agent object writes their entries again,
which keeps ones already written where they are, then submits one input, a
`<backoffice-notifications-request>` element listing each notification by its route, if any, and
event ID. The entry's data is the route ID and event; its model message is one `<backoffice-event>`
element: the event's identity as attributes, its subject and payload as JSON whose `<` is escaped,
so event data cannot close the element. Backoffice guidance tells agents to treat it as data. Users
only submit inputs, which Pi writes as `pi.user`, so the chat's event card cannot be forged. The
chat shows the event cards where Pi placed them and the request as a "Handling N notifications"
divider; a typed request only restyles the typist's own message.

Everything an agent's turns produce, including its `pi` events and any event reclassified or
forwarded from them, keeps the agent's actor among its delegates, and a route never delivers such an
event to that agent.

## Manager routes

All paths below are mounted at `/api/pi-manager` inside the manager object:

- `GET /models`: the `PI_SUPPORTED_MODELS` entries whose provider credentials are available from the
  same registry used by agents, with each model's context window from that registry.
- `GET /agents`: every definition with `provisioned` (`false` until its first turn), and invalid
  definitions.
- `GET /agents/:agentName`: one definition and whether it is provisioned.
- `POST /agents/:agentName/prompts`: `{ requestId, content, whenBusy, whenPaused }`, answering
  `{ requestId, status }` or `409 AGENT_BUSY` for a refused `reject`; see Queue. The first prompt
  provisions the agent. Usage belongs to its scope's root owner, an organization or a user. System
  work has no customer. Reusing a request ID reuses the submission rather than generating another
  answer.
- `POST /agents/:agentName/notifications`: `{ routeId, event }`, answering `204` or
  `404 AGENT_NOT_STARTED`. Automations routes and workflow replies, whose `routeId` is `null`, call
  it; see Notifications.
- `GET /agents/:agentName/submissions/:requestId`: Pi's submission record, or the queue's record of
  an item Pi does not have; see Queue.
- `GET /agents/:agentName/submissions/:requestId/wait?waitMs=...`: bounded, commit-driven wait for a
  queued prompt's dispatch and its submission's settlement.
- `GET /agents/:agentName/view`: Pi's committed active structural conversation view.
- `GET /agents/:agentName/view-stream`: NDJSON `snapshot` and `update` frames of that view,
  interleaved with `queue` frames listing the items waiting in the agent's queue; see Queue.
- `GET /agents/:agentName/entries?cursor=...&pageSize=...`: newest-first, fork-aware durable entry
  history (maximum 256 entries per page).
- `GET /agents/:agentName/export`: streaming versioned JSONL export over every durable entry.
- `POST /agents/:agentName/compact`: admits manual durable compaction with optional instructions.
- `GET /agents/:agentName/compactions/:taskId`: public running/completed/failed compaction state.
- `POST /agents/:agentName/stop`: aborts the agent's current work, including background work, and
  pauses its queue; see Queue.
- `POST /agents/:agentName/resume`: resumes a paused queue; see Queue.

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

## Backoffice execution

`extensions/backoffice/backoffice-extension.ts` installs the shared Backoffice `read`, `search`, and
`execCodeMode` implementations. They use the scoped filesystem, route-backed service runtimes,
existing codemode execution environment, and kernel permission checks of the active turn.
Authorization does not rely on prompt sections or extension environment hooks: Pi reports their
errors but continues generation, so the model boundary and every tool check fail closed.

Pi, codemode, and prerecorded transcription attribute usage to the execution scope's root owner.
Scoped tool calls use the selected scope, not the calling agent's owner. Workflows snapshot the
execution scope and actors and restore them after suspension, retries, and object restarts; they
carry no independent billing choice. See [usage attribution](../billing/README.md).

Runtime tools target the scoped manager directly: `pi.listAgents`, `pi.getAgent`, `pi.submitPrompt`,
`pi.getSubmission`, `pi.runPrompt`, and `pi.stopAgent`. Scoped context handles rebuild this runtime
for the selected scope. Synchronous prompt execution uses Pi Durable's commit-driven submission
waiter through a bounded long-poll request. Prompt request IDs are stable within durable tool
invocations; timeout or caller cancellation stops the wait but does not retract already admitted
work. Manager failures throw `PiManagerRuntimeRequestError` with stable `status` and `code` fields,
which codemode preserves for workflow recovery decisions.

## Backoffice agents UI

The agent route loaders and actions call the scoped manager through `http.fetchAuthorized` and the
Fragno route contract. The UI lists defined agents and where each comes from, starts an agent's
conversation with its first message (no organization is required for personal agents), steers the
sender's own running turn and queues messages otherwise, shows what waits in the composer (the input
Pi holds in `pi.inbox` as steering or up next, then the agent's queue as queued prompts and
notifications), estimates the active context against the conversation's model, runs and monitors
manual compaction, paginates inactive transcript history, downloads streaming JSONL exports, and
stops active work. Messages resume a stopped agent's queue, and while it is paused with items
waiting, the composer's empty send button resumes it. A scoped resource route proxies the agent's
`application/x-ndjson` conversation-view stream to the browser.

## Recovery

`read` and `search` are replay-safe. `execCodeMode` is replay-unsafe: recovery reports an
interrupted call that may have partially run instead of automatically repeating mutations. Prompt
deduplication is not tool-effect deduplication. Scenarios restore a real SQLite snapshot taken after
a codemode mutation and before tool-result settlement, verifying exactly one effect and that the
restored turn record is the recovered tools' authority.

Production registers OpenAI, Anthropic, and Google providers with credentials from Worker bindings
or Node configuration. An agent-scoped billing document and ownerless durable task deliver
cumulative committed model usage to the scope's root owner with an idempotent outbox event. Billing
is required for customer-owned agents. Deliveries queued before ownership-based attribution retain
their old destination until acknowledged; newly queued deliveries use ownership.
