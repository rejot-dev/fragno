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

A turn names the model it runs with and its reasoning effort, or none, which keeps the
conversation's; the agent object configures a named one on the conversation when it admits the turn,
so Pi's `pi.agent` document is where a conversation's model lives. Defined agents name their
definition's model at `low` on every turn. The built-in `assistant` has no definition to update, so
its prompts choose instead: a prompt's `model` is checked against the available models and the
efforts each supports, kept on its queue item, and named by its turn. A prompt that chooses none
keeps the conversation's model, and the first one starts the conversation on GPT-6.1 Sol at
`medium`, or on the first available model where Sol is unavailable, as in scenarios without an
OpenAI key. Notifications and compactions keep the conversation's model.

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
  stop, so a workflow waiting for a prompt's turn event keeps waiting.

Each change is one retrieve and one mutation, then the queue's publication to the agent object (see
below) and at most one other call to it. The mutation decides: it admits the item against the
agent's definition and models as they are then, provisions the agent on its first prompt, and
records the placement. Every change updates the agent row with Fragno's optimistic version check, so
concurrent changes to one queue conflict and retry, and a new item takes the row's new version as
its position. A concurrent first prompt retries on the agent row's unique conflict. The agent's
settled-turn outbox (see Turn events) reports every settled turn through the manager object's
`reportSettledTurn` command, whose mutation settles every item of the dispatched turn and dispatches
the next one, admitted against the definition as it is then. When the definition or model it needs
is gone, every waiting item is dropped with the reason, since admission does not depend on the item.

Items are recorded before the agent receives them. Each handover also triggers a durable hook that
repeats it: `redispatchAgentQueue` hands every unsettled dispatched or steered item over again, and
`writeNotificationCards` writes an arrived notification's card again; Pi keeps the submission of a
request ID it already has. A steer that reaches the agent after its turn ended runs as a follow-up
instead of joining another sender's turn.

A request's submission reads `{ type: "input", status: "queued", requestId }` until Pi has its turn,
and `{ type: "input", status: "dropped", requestId, reason }` once dropped. Once its turn is
dispatched, a request's submission is its turn's, so every notification a turn handled answers with
that turn's submission.

Once a change commits, the manager publishes the agent's waiting items and whether its queue is
paused to the agent object, with the agent row's version as their revision; the agent ignores an
older revision published late. The change stands if publishing fails, and the next change publishes
again. The agent keeps the latest in memory only, so the manager's answer when a viewer connects
carries it too (see View socket). The socket leads with them and sends them again as a `queue` frame
whenever they change.

Work that waits is also recorded as `pi` events, attributed to its sender, so views show the queue
the agent page shows. `queue.added` records an item that starts waiting, with its type: `prompt` or
`notification` for an item in the queue, or `steer` for a steer, which waits in Pi's inbox for the
running turn's next tool boundary. A queued item's wait ends with `queue.dispatched`, naming the
request ID of the turn that took it, or `queue.dropped` with the reason; a steer's ends with its own
`turn.started`, or with its turn's end when a stop cuts it off before Pi places it. Items an idle
agent takes at once never wait, so they record none. The mutation that changes an item triggers the
`recordQueueChange` durable hook, so each event is ingested, keyed by the hook's ID, exactly when
the change commits.

## Turn events

Each prompt Pi starts records `turn.started` in the agent's scope when Pi places it in the
conversation, and each prompt Pi settles records one end: `turn.completed` with the answer's entry
ID, `turn.aborted` for a prompt a stop cut off (Pi's reason `aborted`), or `turn.failed` with Pi's
reason for any other unanswered prompt, such as `model_error`. A started prompt without an end is
running, which is how views show an agent answering. A prompt Pi settles without starting records
only its end, and a withdrawn one records nothing. A steer that joined a running turn starts and
settles with that turn. The event's subject names the agent and the prompt's request ID, its actors
are the turn's execution actors, and its scope restriction is the turn's, so `turn.aborted` names
who prompted the turn; `agent.stopped` names who stopped it. No turn event carries answer text:
event readers need only `events.read`, while conversations stay behind `pi.read`, so a reader of the
answer calls `pi.listMessages` with `before` one past the answer's entry ID. A workflow that submits
a prompt waits for these events instead of the turn: a route sends them to it with
`send_workflow_event`, as Telegram Channel's routes do with the prompt's request ID as the instance
ID.

Pi starts and settles submissions in its own commits, so the turns document is the outbox: a turn
stays in `pending` until it settles, its events are ingested, keyed
`pi:<agentName>:started:<requestId>` and `pi:<agentName>:ended:<requestId>`, and its manager is
told, and then forgotten. Pi keeps a started input's entry once it settles, so a turn that settles
before its start was reported records the start first; recording either again records nothing.
Neither report waits on the other, so an unrecordable event never holds back the agent's queue. A
commit listener reports each start and settlement as it happens, and the alarm reports again after
the agent goes idle, keeping its heartbeat until every settled turn is recorded. Runtimes without
Automations forget settled turns without recording them.

## Agent change events

The manager records what `pi.agent.create`, `pi.agent.update`, `pi.agent.delete`, and
`pi.agent.stop` change, and resuming a stopped agent's queue, as `pi` events in its scope:
`agent.created`, `agent.updated`, and `agent.deleted` carry the definition (the deleted one for
`agent.deleted`), and `agent.stopped` and `agent.resumed` carry nothing. A stopped agent stays
paused until its latest of the two is `agent.resumed`, recorded by the resume route or a prompt with
`whenPaused: "resume"`. Deleting an undefined agent and stopping an agent with no turns change
nothing and record nothing. The subject names the agent, the actors are the requester's, and the
scope restriction is theirs, which the manager middleware puts in the request as `provenance`, as it
does for prompts. Each change triggers the `recordAgentChange` durable hook in the mutation that
makes it, so the event is ingested, keyed by the hook's ID, exactly when the change commits.

These events are the scope's agent directory for views: the scope's agents are Backoffice's built-in
agents, which no scope stores and no event records, and every agent whose latest `agent.created`,
`agent.updated`, or `agent.deleted` event defines it. Agents defined before the events were recorded
are missing until `pi.agent.backfillEvents` records them. The backfill compares each agent's latest
recorded definition with the manager's and records, as its caller, `agent.created` for an agent the
events lack or record deleted, `agent.updated` for a different definition, and `agent.deleted` for a
recorded agent the manager no longer defines. Each backfilled event is keyed by the recorded event
it follows, so a rerun records nothing new.

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
  same registry used by agents, with each model's context window and supported reasoning efforts
  from that registry.
- `GET /agents`: every definition with `provisioned` (`false` until its first turn), and invalid
  definitions.
- `POST /agents`: creates a definition, answering it with `resolvedModel`, the model it runs: its
  `model`, the first available model for null, or null when that model is unavailable.
- `GET /agents/:agentName`: one definition and whether it is provisioned.
- `POST /agents/:agentName/prompts`: `{ requestId, content, whenBusy, whenPaused, model }`,
  answering `{ requestId, status }` or `409 AGENT_BUSY` for a refused `reject`; see Queue. `model`
  is `{ provider, modelId, thinkingLevel }` or `null`; only built-in agents choose one, and others
  answer `400 MODEL_NOT_CHOOSABLE`; see Agent definitions. The first prompt provisions the agent.
  Usage belongs to its scope's root owner, an organization or a user. System work has no customer.
  Reusing a request ID reuses the submission rather than generating another answer.
- `POST /agents/:agentName/notifications`: `{ routeId, event }`, answering `204` or
  `404 AGENT_NOT_STARTED`. Automations routes and workflow replies, whose `routeId` is `null`, call
  it; see Notifications.
- `GET /agents/:agentName/submissions/:requestId`: Pi's submission record, or the queue's record of
  an item Pi does not have; see Queue.
- `GET /agents/:agentName/view`: Pi's committed active structural conversation view.
- `GET /agents/:agentName/entries?cursor=...&pageSize=...`: newest-first, fork-aware durable entry
  history (maximum 256 entries per page).
- `GET /agents/:agentName/messages?last=...&before=...`: the `last` (default 20, at most 100)
  messages said before entry `before`, or the latest ones, oldest first; see Reading conversations.
- `GET /agents/:agentName/export`: streaming JSONL export of every durable entry, oldest first,
  after a `{ type: "pi-durable-agent", version: 2, order: "oldest-first" }` header line.
- `POST /agents/:agentName/compact`: admits manual durable compaction with optional instructions.
- `GET /agents/:agentName/compactions/:taskId`: public running/completed/failed compaction state.
- `POST /agents/:agentName/stop`: aborts the agent's current work, including background work, and
  pauses its queue; see Queue.
- `POST /agents/:agentName/resume`: resumes a paused queue; see Queue.

Conversation routes return `404 AGENT_NOT_STARTED` before an agent's first turn. A damaged Chord
document path returns `409 PI_CONVERSATION_VIEW_DAMAGED` from the view route, and closes the view
socket, instead of presenting an entry-only view as an idle conversation. Durable entry history and
JSONL export remain independent read paths.

Manager HTTP requests must use `http.fetchAuthorized` with a matching execution scope. The manager
verifies the signed object address and enforces the existing `pi.read` / `pi.modify` permissions.

The agent persists an alarm before admitting input. Alarm invocations resume Pi's own scheduler,
retain a recovery heartbeat while work remains, and clear the alarm when the agent is idle. There is
no Fragno workflow involved in agent execution. The same manager and agent lifecycle runs in
Cloudflare and local/Node runtimes. Local agents use Pi Durable's Node SQLite adapter: in-memory
SQLite for transient scenarios, or one `pi-agent-*.sqlite` file per agent in the configured SQLite
data directory.

## View socket

Viewers watch an agent's conversation over a WebSocket that the agent object serves, with no manager
in between: the browser through the agent page's `view-socket` route, and API callers through
`pi.agent.watch` (see `@fragno-dev/backoffice-api`'s README). The worker signs the upgrade with the
viewer's execution for the agent (`runtime.objects.piAgent(agent).fetchAuthorized`, with
`piAgentViewSocketRequest`), and the request names the agent, so its object checks the signature,
and that the name is its own, before reading anything. It then asks its manager over RPC whether the
viewer may watch (`authorizeViewer`): the manager makes the checks of its routes' GETs, scope and
`pi.read`, refuses an agent without turns or a name no agent has, and answers with what waits in the
queue.

The socket's JSON frames are `queue`, then `view` with the whole view, then `ops` with each commit's
Chord ops, including partial answers while the agent generates, which the browser applies with
`applyImmutable`. One watch serves all of an agent's sockets, so each commit is encoded once, and
its frame is the size of the change, not of the conversation. A refusal or a damaged view closes the
socket with a code from 4000 up (`PI_AGENT_WATCH_REFUSED`) and the reason; any other close is worth
reconnecting after, which starts again from a whole view. Only Cloudflare serves view sockets; the
Node runtime throws.

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

Runtime tools target the scoped manager directly: `pi.listAgents`, `pi.getAgent`, `pi.listMessages`,
`pi.exportConversation`, `pi.submitPrompt`, `pi.stopAgent`, and `pi.backfillAgentEvents`. Scoped
context handles rebuild this runtime for the selected scope. No tool waits for a turn; its turn
events report how it ended. Prompt request IDs are stable within durable tool invocations. Manager
failures throw `PiManagerRuntimeRequestError` with stable `status` and `code` fields, which codemode
preserves for workflow recovery decisions.

## Reading conversations

Users and agents with `pi.read` read any started agent of a scope, as the agents UI does. A reader
sees every tool result, including data the agent fetched with permissions the reader lacks.

`pi.listMessages` (`pi.agent.messages`) returns what was said: each user input's text, the text of
each model response, including narration between tool calls, and a `notification` marker where a
turn handled delivered events, which explains an answer no one prompted. Thinking, tool calls, tool
results, notification cards, and compaction summaries are left out. The agent scans entries
newest-first until it holds one message more than asked for, so `before`, the oldest returned
message's entry ID, is null exactly when no earlier message exists. An aborted response that a newer
one in its task repeats is a recovery partial and is skipped, as the chat skips it, unless the two
fall on different pages. `pi.agent.messages --agent assistant --last 1` prints only the latest
message; `--format json` prints the page.

`pi.exportConversation` (`pi.agent.export`) writes the export route's JSONL to a `.jsonl` file under
`/workspace` and also needs `upload.modify`. It holds the whole export in memory to write it in one
piece.

Both answer `404 AGENT_NOT_FOUND` for a name no agent has, and `AGENT_NOT_STARTED` only for a
defined agent without turns, so a typo is not mistaken for an idle agent. A deleted agent's
conversation stays readable. Models asked about "the assistant" tend to read their own conversation,
so the operations tell them to find the agent meant with `pi.listAgents`.

## Backoffice agents UI

The agent route loaders and actions call the scoped manager through `http.fetchAuthorized` and the
Fragno route contract. The agent tabs, the agents overview, and the dashboard's Agents panel read
the scope's agents from its synchronized `pi` events (see Agent change events), with whether each is
answering or stopped, how much work is queued or steering and whether a stop holds it, its latest
event, and its turns over the last day; an agent's page loads that agent from the manager, which
says whether it has started. The UI shows where each agent comes from, starts an agent's
conversation with its first message (no organization is required for personal agents), steers the
sender's own running turn and queues messages otherwise, shows what waits in the composer (the input
Pi holds in `pi.inbox` as steering or up next, then the agent's queue as queued prompts and
notifications), estimates the active context against the conversation's model, runs and monitors
manual compaction, paginates inactive transcript history, downloads streaming JSONL exports, and
stops active work. Messages resume a stopped agent's queue, and while it is paused with items
waiting, the composer's empty send button resumes it. A scoped resource route upgrades the browser
to the agent's view socket, which reconnects with backoff until the agent refuses it.

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
