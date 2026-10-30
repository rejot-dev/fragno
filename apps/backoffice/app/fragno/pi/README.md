# Durable Pi

Backoffice Pi runs a finite set of defined **agents** per scope. Each agent is one durable `PI`
object with one ongoing root conversation, compacted automatically, that runs one turn at a time.

- `workers/pi-manager.do.ts`: one `PI_MANAGER` object per execution scope, with the same singleton,
  organization, user, and project scopes as Automations. Use `objects.piManager.for(scope)` or its
  `singleton`, `forOrg`, and `forUser` selectors. Its embedded Fragno fragment stores agent
  definitions and records which agents have been provisioned.
- `workers/pi.do.ts`: one `PI` object per agent, addressed by `piAgentObjectName` from its scope and
  agent name. Pi Durable's `openDurableObjectSqliteStorage` keeps transcripts, submissions,
  documents, and tasks in the object's SQLite database, in `pi_*` tables.

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
  instruction sections, and the `codemode` tool), `billing/` (usage delivery task and document), and
  `posthog/` (generation analytics, production Cloudflare only).
- `manager/`: the scoped agent directory fragment and the runtime that runtime tools and codemode
  use to call it.

## Agent definitions

A scope's agents are rows in the manager's `agent_definition` table, keyed by agent name, plus the
built-in `assistant` defined in `agent/agent-definitions.ts`, whose name a scope cannot take. A
definition holds a `description`, a `provider/modelId` `model` or null for the first available
model, at least one permission grant (`*`, which narrows nothing, `namespace.*`, or catalog
entries), Markdown `instructions`, and its `steward`: members, or the Marketplace package that
declares it, which installing and uninstalling keep in sync, as they do routes. Built-in agents are
Backoffice's. `pi.agent.create`, `pi.agent.update`, and `pi.agent.delete` change members'
definitions and require `pi.manage`, so only they and package installations can change what an agent
is told; input is validated on write, so the directory holds no unusable definitions. Deleting a
definition keeps the `agent` provisioning row and its conversation.

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

A conversation's current run (`pi.live` `run.inputs[0]`) identifies the owning turn, and each
conversation runs one turn at a time: the root's, or a subagent's (see Subagents). Work outside any
run, such as compaction, uses the latest admitted turn; manual compaction records its requester
first, and the queue's compaction the turn it follows. A turn is recorded before Pi admits its
prompt, so no work can start without it, and withdrawn if Pi does not admit it, so a refused prompt
never decides whom later work runs as. Work a turn persists, such as workflows or events, keeps the
`pi-agent` actor, whose static role grants everything: it runs as the principal without the
definition's narrowing.

## Subagents

A subagent is a one-task conversation of an agent, inside the agent's object and under its
definition: it answers one prompt beside the agent's own conversation and ends. Any prompter, the
agent itself included, starts one the same way: `pi.prompt.submit` with `subagent: true`, which
queues a `subagent` item (see Queue).

The agent object records each subagent under the request ID that asked for it, in the
`backoffice.pi.subagent` document family (`agent/pi-agent-subagents.ts`), from when the queue takes
it: `waiting`, `starting` once its conversation exists, `started` once its prompt is submitted
there, or `dropped` if the queue dropped it before it started. The queue tells the agent object that
a subagent waits or was dropped by a handover its `recordSubagent` hook repeats until it lands. The
submit route returns a subagent's request ID only once that handover landed, since a turn may wait
for the subagent as soon as it has the ID; if it failed, the route answers `AGENT_UNAVAILABLE`
(503), the subagent stays queued, and submitting the same request ID again tells the agent object
once more, while a new one would start a second subagent. Its submission, transcript, and messages
read by that request ID; `backoffice.pi.subagents.running` lists those whose work may still run.

`startSubagent` creates an ownerless conversation without the `awaitSubagents` tool, records the
item's turn under its request ID like a root turn's, and submits the prompt; a handover repeated
after a crash finds the conversation and submission again. A subagent reports its `turn.*` events,
settles, and replies like any prompt, so `pi.prompt.get`, `notifyWhenDone`, and workflows waiting
for its events work unchanged. A stop aborts it by name, since no task owns it. An agent may start
subagents of itself with `notifyWhenDone`: the reply comes from another conversation, once.

**Joining.** A turn waits for subagents of its agent with `awaitSubagents`
(`extensions/backoffice/await-subagents-tool.ts`), which returns each one's answer, failure, or drop
in the order asked, and `notFound` for a request ID the agent has no record of. It watches each
subagent's record until it is `started` or `dropped`, then waits for its submission, so it also
waits for subagents still waiting for a slot; a rerun after a restart reads the same records again.
Subagents run without it: four subagents waiting for subagents of their own would hold every slot
those need. Stopping the agent aborts the waiting turn with its subagents. A turn that waits for a
subagent should not also ask to be notified of it, or hears its end twice.

A subagent's work runs as its own turn. `readActivePiAgentTurn` reads the turn of the conversation's
run; outside any run only the root's work has an authority, the latest admitted turn. The model
boundary has no conversation, so it finds one by the provider session ID Pi sends with each request:
the root's, or a running subagent's, and fails closed for any other. Deferred fetches carry no
session and are checked as the root's. Billing counts subagents, as it bills the session's usage. Pi
cannot delete conversations, so a finished subagent's stays in the agent's storage.

**On the agent's page.** Subagents show in the agent's thread, one card per batch
(`routes/backoffice/agents/agent-subagent-batches.tsx`). A subagent started from a tool call of the
agent's own turn is listed under that call: `pi.submitPrompt` sends the call's ID as
`askingToolCall`, which the prompt route accepts only from the agent's own turn and only for a
subagent. Those anyone else asks for, another agent, an app, or a person, show where they were
asked, after the turn then running, one card per asker. The list route returns the latest 50 and any
still running before them, since Stop and the thread follow what runs, with each one's start and
answer times and its answer, which the agent object reads in one call (`getSubagentRuns`); the page
reads the transcripts of running ones, a few at a time, for what they do now, and a row opens its
subagent's transcript. Stop shows while subagents run, also beside an idle conversation, and Resume
while a stopped agent's subagents wait.

## Queue

The manager logs every prompt and notification an agent receives in its `agent_queue_item` table,
and Pi only ever receives a steer or the one turn the queue dispatched. An item is `queued`,
`dispatched` (in the turn Pi runs), `steered` (joined that turn), `settled`, or `dropped`; a
dispatched or settled item names its turn by the turn's Pi request ID. Items stay after they end, so
a resent request ID keeps its first placement and never runs twice; nothing prunes the log yet.

The queue follows six rules for the agent's own conversation. `nextPiAgentQueueTurn` in
`pi-agent-queue-rules.ts` applies the first four, which pick each turn:

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
- `reject` is refused with `409 AGENT_BUSY` while the conversation is busy or items wait.
- The conversation is busy while a turn or compaction is dispatched, and until every steer settled:
  Pi starts a steer it takes at a turn's final answer as a run of its own as that turn settles. With
  the conversation free and the queue running, a new item is dispatched at once; items wait only
  behind a busy conversation or in a paused queue.
- Stopping an agent (`pi.agent.stop`) pauses its queue and aborts what Pi holds; the stopped turn
  settles unanswered and nothing starts after it. A paused queue records new items but dispatches
  none, even for an idle agent, and a steer never joins the stopped turn.
  `POST /agents/:agentName/resume`, or a prompt with `whenPaused: "resume"`, resumes it: the next
  turn starts at once, or when the stopped turn settles, with the queue's oldest item. The
  Backoffice UI sends `resume`; the default, `wait`, keeps automations and workflows from undoing a
  stop, so a workflow waiting for a prompt's turn event keeps waiting.
- A stop also holds back work handed over before it but not yet started: a turn, steer, or subagent
  whose handover is still on its way or failed. Each handover carries the queue revision that issued
  it; the stop passes its own to the agent, which refuses earlier ones from then on, and the queue's
  hook retries nothing while the queue is paused. Resuming runs the hook, which hands them over
  again at the new revision.

The queue also compacts the conversation between turns. Pi's background compaction is off, since it
ran beside a turn and could overlap another compaction. Instead, the agent reports with each settled
root turn whether its context passed the point where Pi would have started one, `backgroundTokens`
below Pi's blocking threshold (`isPiCompactionDue`). The queue then dispatches a `compaction` item,
`compaction:<requestId>` after the settlement it follows, once the conversation is free, ahead of
everything waiting, and under the authority of that turn or steer. It holds the conversation like a
turn: items wait behind it, and a steer waits too rather than start a turn beside it. The agent
reports its end, however it ended, as a settlement, which starts the next turn. A paused queue
compacts nothing. A turn that outgrows the window on its own still compacts at Pi's blocking
threshold, or on overflow. Thresholds are the model's own: its `modelOverrides` entry over the
harness-wide policy.

Pi's compaction carries no request ID, so the agent records the newest one it started with the queue
revision of its handover. The queue dispatches a compaction only once the one before it settled, at
a later revision, so a handover of a compaction again, or of an older one, starts nothing. Like a
turn, a compaction handed over before a stop starts only once the queue resumes.

Subagent items (see Subagents) run beside the agent's turns rather than in them, so they wait only
for a slot: up to `PI_AGENT_SUBAGENT_LIMIT`, four, run at once per agent, each dispatched as its own
turn under its own request ID, and the oldest waiting one starts when one settles. A paused queue
holds them too, and resuming starts them. `whenBusy` concerns only the agent's conversation, so a
subagent prompt that asks to steer or reject is refused with `SUBAGENT_NOT_BUSY`, and the waiting
queue the conversation's viewers see lists only its own items. The agent's subagent items are
indexed by agent and position, for their list.

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
answer calls `pi.getPrompt` with the subject's request ID. A workflow that submits a prompt waits
for these events instead of the turn: a route sends them to it with `send_workflow_event`, as
Telegram Channel's routes do with the prompt's request ID as the instance ID.

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
`POST /agents/:agentName/notifications`. A workflow an agent starts replies through the same route,
with no route ID and the run's execution: when the run ends, Automations notifies the agent with a
`workflows` `instance.completed` event carrying its status, output, and error, and naming the run's
scope, workflow, and instance ID. The chat shows the output's file images and links from the run's
scope, resolved from the page's scope, the viewer's organizations, or a personal scope; a scope it
cannot resolve, such as another owner's project, leaves images as placeholders and paths unlinked
rather than showing another scope's files. Inline `codemode` workflows always reply; a saved one
started with `workflow.createInstance` replies when the call passes `notifyWhenDone`, also when the
run is in another scope. A run's `replyTo` agent names its scope, where the reply is delivered; runs
stored before it did reply to their own scope. The workflows middleware accepts a `replyTo` agent
only from that agent's own turn, which it recognizes by the agent's delegate actor, whose ID names
the agent's scope. Only `createAgentRouteBackedRuntimeContext`, which a turn's tools use, knows a
calling agent; other callers asking for a reply get `WORKFLOW_REPLY_NOT_ALLOWED`.

An agent's turn hears how a prompt it sends ends by passing `notifyWhenDone` to `pi.submitPrompt`,
also when the prompted agent is in another scope. The runtime names the calling agent as the
prompt's `replyTo`, which the prompted agent's manager accepts only when the requester's actors
include that agent's delegate actor. That actor's ID names the agent's scope, so the check holds
across scopes. It refuses a `replyTo` naming the prompted agent itself: prompting yourself only
queues another turn of your own conversation, and its reply could wake you again and again. The
queue item keeps `replyTo`. When the item's turn settles, the agent reports the `turn.*` event that
records how it ended with the settlement, and the manager forwards it; when the queue drops the
item, it sends a `queue.dropped` event. The `replyToAgent` durable hook delivers either event
through the calling agent's manager, with no route, as the prompt's sender, so the calling agent
handles it with its own turn's authority. The reply carries the hook's ID as its event ID: the
calling agent's queue deduplicates replies by it, and same-named agents of two scopes record the
same turn event IDs for the same request ID. The prompted agent's `pi` events carry the calling
agent's delegate actor, so no route delivers them to it; `replyTo` is how it hears back.

A notification is a queue item whose sender is the route's, the workflow run's, or the replying
prompt's execution, so the request to handle it waits its turn like a prompt (see Queue). One whose
sender also sent the dispatched turn joins that turn instead, as a steer whose input is the event
itself: the turn sees it at its next boundary anyway, so a turn of its own would find it handled.
Subagents asked to report back that end together are handled this way, by the turn the first report
starts. Its request ID is `route:<routeId>:<eventId>`, or `reply:<eventId>` without a route, so
redelivering an event through one route, or to the agent directly, places nothing new, even after it
was handled. Notifications never provision an agent: a person must start the conversation first. An
agent with no turns answers `404 AGENT_NOT_STARTED`.

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
chat shows the events a turn was given, those above its request and those placed while it ran, as
one line above it, and events no turn takes where Pi placed them. A report of one of the agent's own
subagents names its task and leads to its card. A typed request only restyles the typist's own
message.

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
- `POST /agents/:agentName/prompts`: `{ requestId, content, whenBusy, whenPaused, model, replyTo }`,
  answering `{ requestId, status }`, `400 INVALID_PROMPT` for a request ID starting with `route:`,
  `reply:`, or `compaction:`, which name Backoffice's own work (`PI_INTERNAL_REQUEST_ID_PREFIX`),
  `409 AGENT_BUSY` for a refused `reject` (see Queue), or `403 USAGE_LIMIT_EXCEEDED` once the root
  owner used up its monthly `ai.cost.total` limit (see
  [Usage limits](../billing/README.md#usage-limits)). `model` is
  `{ provider, modelId, thinkingLevel }` or `null`; only built-in agents choose one, and others
  answer `400 MODEL_NOT_CHOOSABLE`; see Agent definitions. `replyTo` is `{ scope, agentName }` or
  `null`; naming an agent the requester does not act through answers `400 REPLY_NOT_ALLOWED`; see
  Notifications. The first prompt provisions the agent. Usage belongs to its scope's root owner, an
  organization or a user. System work has no customer. Reusing a request ID reuses the submission
  rather than generating another answer.
- `POST /agents/:agentName/notifications`: `{ routeId, event }`, answering `204` or
  `404 AGENT_NOT_STARTED`. Automations routes and workflow replies, whose `routeId` is `null`, call
  it; see Notifications.
- `GET /agents/:agentName/prompts/:requestId`: where the prompt stands, as `pi.getPrompt` answers,
  from Pi's submission of the turn that handled it, or the queue's record of an item Pi does not
  have; see Queue. A completed prompt's `answer` is read from the answer's entry, so a later
  compaction or clear leaves it readable.
- `GET /agents/:agentName/view`: Pi's committed active structural conversation view.
- `GET /agents/:agentName/entries?cursor=...&pageSize=...`: newest-first, fork-aware durable entry
  history (maximum 256 entries per page).
- `GET /agents/:agentName/messages?last=...&before=...`: the `last` (default 20, at most 100)
  messages said before entry `before`, or the latest ones, oldest first; see Reading conversations.
- `GET /agents/:agentName/export?history=true`: streaming JSONL export of the durable entries,
  oldest first, after a `{ type: "pi-durable-agent", version: 3, order: "oldest-first", history }`
  header line; see Reading conversations.
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

The agent persists an alarm before admitting input. Alarm invocations resume Pi's own scheduler and
keep a recovery heartbeat until no work can run, as `harness.wake()` tells through `onWake`. Pi
keeps no timers for sleeps, such as retry backoffs: a waiting alarm resumes a sleep that comes due
beside running work, and once no work can run, the alarm moves to the earliest sleep, so the object
holds no invocation while it waits. A session that fails, as on a storage error, fails the waiting
alarm at once, and the next call or alarm opens the agent again. An agent with no sleeps, or only
tasks parked after repeated crashes, clears its alarm. There is no Fragno workflow involved in agent
execution. The same manager and agent lifecycle runs in Cloudflare and local/Node runtimes. Local
agents use Pi Durable's Node SQLite adapter: in-memory SQLite for transient scenarios, or one
`pi-agent-*.sqlite` file per agent in the configured SQLite data directory.

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

The sockets are hibernatable (`ctx.acceptWebSocket`), so open tabs do not keep an idle agent in
memory. Hibernation drops the watch, so an agent woken with sockets attached opens a new one before
anything else uses the agent and sends each socket a whole `view` again: reopening may commit what
the sockets never saw. Queue frames reach them meanwhile. The queue the agent last had is forgotten
too, so the first publication after waking is taken whatever its revision.

## Backoffice execution

`extensions/backoffice/backoffice-extension.ts` installs the shared Backoffice `codemode`
implementation. It uses the scoped filesystem, route-backed service runtimes, existing codemode
execution environment, and kernel permission checks of the active turn. Agents discover guidance,
skills, and declarations inside codemode through `state`, whose discovery methods the guidance
section inlines, so discovery shares a turn with other reads. The guidance lists every other
declaration file with a one-line summary of when to read it. Authorization does not rely on prompt
sections or extension environment hooks: Pi reports their errors but continues generation, so the
model boundary and every tool check fail closed.

Pi, codemode, and prerecorded transcription attribute usage to the execution scope's root owner.
Scoped tool calls use the selected scope, not the calling agent's owner. Workflows snapshot the
execution scope and actors and restore them after suspension, retries, and object restarts; they
carry no independent billing choice. See [usage attribution](../billing/README.md).

Runtime tools target the scoped manager directly: `pi.listAgents`, `pi.getAgent`, `pi.listMessages`,
`pi.exportConversation`, `pi.submitPrompt`, `pi.getPrompt`, `pi.stopAgent`, and
`pi.backfillAgentEvents`. Scoped context handles rebuild this runtime for the selected scope. No
tool waits for a turn; its turn events report how it ended. Prompt request IDs are stable within
durable tool invocations. Manager failures throw `PiManagerRuntimeRequestError` with stable `status`
and `code` fields, which codemode preserves for workflow recovery decisions.

## Reading conversations

Users and agents with `pi.read` read any started agent of a scope, as the agents UI does. A reader
sees every tool result, including data the agent fetched with permissions the reader lacks.

Both read what the chat shows: the active context, from the newest compaction's first kept entry, or
the newest clear, on. A compaction's summary stands where it was made, after the entries it kept;
compactions it replaced do not. Only the export reads every entry, with `history` (`--history`), as
the chat does once it loads earlier history; a prompt's answer is read with `pi.getPrompt` instead.
The agent reads the newest head marker in its own commit, so finding the active context costs no
scan.

`pi.listMessages` (`pi.agent.messages`) returns what was said: each user input's text, the text of
each model response, including narration between tool calls, a `notification` marker where a turn
handled delivered events, which explains an answer no one prompted, and each `compaction` summary.
Thinking, tool calls, tool results, and notification cards are left out. The agent scans entries
newest-first until it holds one message more than asked for, so `before`, the oldest returned
message's entry ID, is null exactly when no earlier message is in the active context. An aborted
response that a newer one in its task repeats is a recovery partial and is skipped, as the chat
skips it, unless the two fall on different pages. `pi.agent.messages --agent assistant --last 1`
prints only the latest message; `--format json` prints the page.

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
manual compaction, paginates inactive transcript history, downloads streaming JSONL exports of the
whole history, and stops active work. Messages resume a stopped agent's queue, and while it is
paused with items waiting, the composer's empty send button resumes it. A scoped resource route
upgrades the browser to the agent's view socket, which reconnects with backoff until the agent
refuses it.

## Recovery

`codemode` is replay-unsafe: recovery reports an interrupted call that may have partially run
instead of automatically repeating mutations. Prompt deduplication is not tool-effect deduplication.
Scenarios restore a real SQLite snapshot taken after a codemode mutation and before tool-result
settlement, verifying exactly one effect and that the restored turn record is the recovered tools'
authority.

Production registers OpenAI, Anthropic, and Google providers with credentials from Worker bindings
or Node configuration. An agent-scoped billing document and ownerless durable task deliver
cumulative committed model usage to the scope's root owner with an idempotent outbox event. Billing
is required for customer-owned agents. Deliveries queued before ownership-based attribution retain
their old destination until acknowledged; newly queued deliveries use ownership.
