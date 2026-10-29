---
name: pi-agents
description: >
  Define, change, and prompt Pi agents: named instructions and permissions with one ongoing
  conversation each, and their one-task subagents. Load when creating, editing, or deleting an
  agent, choosing which agent should do work, or delegating work to subagents.
---

# Pi agents

An agent is a definition in its scope: its instructions are extra system guidance and its
permissions narrow what its turns may do. Each agent keeps one ongoing conversation per scope,
compacted automatically, and runs one turn at a time. `assistant` is built in everywhere.

## Define an agent

```ts
await pi.createAgent({
  agentName: "triage",
  description: "Reviews workflow failures and proposes fixes.",
  model: null,
  permissions: ["*"],
  instructions:
    "Investigate the failure you are given before changing anything. Report the cause and the fix.",
});
```

- `agentName`: a lowercase letter, then lowercase letters, digits, or hyphens. Names are unique in a
  scope; `assistant` is taken.
- `description` tells people and other agents what the agent is for.
- `model` is `provider/modelId`, or null for the preferred available model. The created agent's
  `resolvedModel` names the model it runs, so you can tell whoever asked which one that is.
- `permissions`: use `["*"]` unless you want to limit the agent. Each turn already runs with the
  prompter's permissions; these grants only narrow them, so `["*"]` narrows nothing. To limit the
  agent, list `namespace.*` or `namespace.permission` entries from the permission catalog. At least
  one grant is required. Prompting the agent requires the prompter's own `pi.modify`.
- `instructions` is Markdown added to the agent's system prompt, up to 32,768 characters; empty adds
  none.
- An agent's `steward` says who may change it: `members` for agents defined this way, a `package`
  for agents a Marketplace package declares, as `/static/skills/marketplace-publishing/SKILL.md`
  shows, and `backoffice` for built-in agents.

Defining, updating, and deleting agents requires `pi.manage`. Invalid input is refused with the
reason, so nothing unusable is ever defined.

**Complete when** `pi.listAgents({})` lists the agent and a prompt to it is admitted.

## Change or remove an agent

`pi.updateAgent` takes the whole definition again, instructions included, and replaces it; the next
turn uses it. Read the current definition with `pi.getAgent` first so you only change what you mean
to. `pi.deleteAgent({ agentName })` removes the definition but keeps the conversation: defining the
name again resumes it. Only members' agents change this way: a package's agents change when the
package is installed again and go when it is uninstalled, and built-in agents never change.

## How permissions work

A turn runs as whoever prompted it, with that principal's current permissions, narrowed by the
definition's `permissions`. A definition can only restrict: editing it never grants more than the
person or workflow prompting the agent already has. Changes to a definition apply from the next
turn.

Work a turn persists, such as a workflow it starts, runs with the prompter's permissions without the
definition's narrowing.

## Subagents

A subagent is a one-task conversation of an agent, under the agent's definition: it sees only its
task, answers it beside the agent's own conversation, and ends. Start one with
`pi.submitPrompt({ agentName, content, subagent: true })`, for an agent or yourself, with a
self-contained `content`, such as one task per document. Four run at once per agent; more wait for a
slot. Then get their answers one of two ways, not both:

- **In this turn:** call the `awaitSubagents` tool with the request IDs `pi.submitPrompt` returned.
  It waits for subagents of yourself, also those still waiting for a slot, and returns each one's
  answer in the order given. Start them all first, then wait once.
- **Later:** pass `notifyWhenDone` to be notified as each one ends, and read its answer with
  `pi.getPrompt({ agentName, requestId })`.

Subagents cannot wait for subagents. Prompt a named agent without `subagent` instead when the work
needs that agent's conversation.

## Prompt an agent

Use `pi.submitPrompt` with `agentName`; it returns once the prompt is queued. The prompt's `pi`
events report how it ended: `turn.completed`, `turn.failed`, `turn.aborted`, or `queue.dropped`,
each with the receipt's `requestId` in its subject. A workflow waits for them as
`/static/skills/workflows/SKILL.md` shows. An agent hears back by passing `notifyWhenDone: true`,
also to an agent of another scope through `context.org(...)` or `context.user(...)`: the event
arrives as a notification that starts a later turn of yours, so end your turn instead of polling.
You cannot be notified of prompts to yourself: check your own `agentName` and scope before asking
another agent, since `assistant` exists in every scope. Read the answer in the prompted agent's
scope with `pi.getPrompt({ agentName, requestId })`, which also says whether a prompt is `queued`,
`running`, `completed` with its `answer`, or `failed` with a reason, or null when the agent never
received it. Prompts wait in the agent's queue and run one turn each, in arrival order
(`whenBusy: "followUp"`, the default), under the agent's definition as it is when their turn starts.
`steer` joins the running turn at its next tool boundary only when the running turn has the same
authority; otherwise it is queued, and the receipt's `status` says `queued` instead of `steered`.
`reject` fails with `409 AGENT_BUSY` while the agent runs a turn or has queued work. Event
notifications wait in the same queue, and those from one sender share a turn. Aborting an agent
pauses its queue: queued work, including yours, waits until a person resumes it.
