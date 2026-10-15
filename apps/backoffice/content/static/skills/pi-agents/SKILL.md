---
name: pi-agents
description: >
  Define, change, and prompt Pi agents: named instructions and permissions with one ongoing
  conversation each. Load when creating, editing, or deleting an agent, packaging one, or choosing
  which agent should do work.
---

# Pi agents

An agent is a definition in its scope plus an instructions file: the file is extra system guidance
and the definition narrows what its turns may do. Each agent keeps one ongoing conversation per
scope, compacted automatically, and runs one turn at a time. `assistant` is built in everywhere.

## Define an agent

Write the instructions as a Markdown file anywhere in the workspace, then define the agent:

```ts
await state.writeFile({
  path: "/workspace/agents/triage.md",
  content:
    "Investigate the failure you are given before changing anything. Report the cause and the fix.",
});
await pi.createAgent({
  agentName: "triage",
  description: "Reviews workflow failures and proposes fixes.",
  model: null,
  permissions: ["workflow.*", "upload.read"],
  instructionsPath: "/workspace/agents/triage.md",
  managedBy: null,
});
```

- `agentName`: a lowercase letter, then lowercase letters, digits, or hyphens. Names are unique in a
  scope; `assistant` is taken.
- `description` tells people and other agents what the agent is for.
- `model` is `provider/modelId`, or null for the preferred available model.
- `permissions` lists `*`, `namespace.*`, or `namespace.permission` entries from the permission
  catalog. They bound the agent's tools; prompting the agent requires the prompter's own
  `pi.modify`.
- `instructionsPath` must exist when you define the agent, or be null for no extra guidance.
- `managedBy` is null for your own agents; Marketplace packages set it to claim theirs.

Defining, updating, and deleting agents requires `pi.manage`. Invalid input is refused with the
reason, so nothing unusable is ever defined.

**Complete when** `pi.listAgents({})` lists the agent and a prompt to it is admitted.

## Change or remove an agent

Edit the instructions file to change how the agent behaves; the next turn reads it. `pi.updateAgent`
takes the whole definition again and replaces it. `pi.deleteAgent({ agentName })` removes the
definition but keeps the conversation: defining the name again resumes it. Built-in agents cannot be
changed or deleted.

## Package an agent

Ship the instructions file in the package and define the agent from
`.marketplace/install.workflow.js` with the installed path from `event.payload.installedFiles`, the
same way packages register routes: create it when missing, update it when this installation's
`managedBy` owns it, and fail otherwise.

## How permissions work

A turn runs as whoever prompted it, with that principal's current permissions, narrowed by the
definition's `permissions`. A definition can only restrict: editing it never grants more than the
person or workflow prompting the agent already has. Changes to a definition apply from the next
turn.

Work a turn persists, such as a workflow it starts, runs with the prompter's permissions without the
definition's narrowing.

## Prompt an agent

Use `pi.submitPrompt` or `pi.runPrompt` with `agentName`. A prompt to a busy agent waits for the
current turn (`whenBusy: "followUp"`, the default). `steer` joins the running turn at its next tool
boundary only when the running turn has the same authority; otherwise it waits, and the receipt's
`whenBusy` says `followUp`. `reject` fails with `409 AGENT_BUSY` and queues nothing. Aborting an
agent drops its queued prompts.
