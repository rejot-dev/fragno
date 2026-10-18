---
name: pi-agents
description: >
  Define, change, and prompt Pi agents: named instructions and permissions with one ongoing
  conversation each. Load when creating, editing, or deleting an agent, packaging one, or choosing
  which agent should do work.
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
  managedBy: null,
});
```

- `agentName`: a lowercase letter, then lowercase letters, digits, or hyphens. Names are unique in a
  scope; `assistant` is taken.
- `description` tells people and other agents what the agent is for.
- `model` is `provider/modelId`, or null for the preferred available model.
- `permissions`: use `["*"]` unless you want to limit the agent. Each turn already runs with the
  prompter's permissions; these grants only narrow them, so `["*"]` narrows nothing. To limit the
  agent, list `namespace.*` or `namespace.permission` entries from the permission catalog. At least
  one grant is required. Prompting the agent requires the prompter's own `pi.modify`.
- `instructions` is Markdown added to the agent's system prompt, up to 32,768 characters; empty adds
  none.
- `managedBy` is null for your own agents; Marketplace packages set it to claim theirs.

Defining, updating, and deleting agents requires `pi.manage`. Invalid input is refused with the
reason, so nothing unusable is ever defined.

**Complete when** `pi.listAgents({})` lists the agent and a prompt to it is admitted.

## Change or remove an agent

`pi.updateAgent` takes the whole definition again, instructions included, and replaces it; the next
turn uses it. Read the current definition with `pi.getAgent` first so you only change what you mean
to. `pi.deleteAgent({ agentName })` removes the definition but keeps the conversation: defining the
name again resumes it. Built-in agents cannot be changed or deleted.

## Package an agent

Define the agent, instructions included, from `.marketplace/install.workflow.js`, the same way
packages register routes: create it when missing, update it when this installation's `managedBy`
owns it, and fail otherwise.

## How permissions work

A turn runs as whoever prompted it, with that principal's current permissions, narrowed by the
definition's `permissions`. A definition can only restrict: editing it never grants more than the
person or workflow prompting the agent already has. Changes to a definition apply from the next
turn.

Work a turn persists, such as a workflow it starts, runs with the prompter's permissions without the
definition's narrowing.

## Prompt an agent

Use `pi.submitPrompt` or `pi.runPrompt` with `agentName`. Prompts wait in the agent's queue and run
one turn each, in arrival order (`whenBusy: "followUp"`, the default), under the agent's definition
as it is when their turn starts. `steer` joins the running turn at its next tool boundary only when
the running turn has the same authority; otherwise it is queued, and the receipt's `status` says
`queued` instead of `steered`. `reject` fails with `409 AGENT_BUSY` while the agent runs a turn or
has queued work. Aborting an agent drops its queued prompts.
