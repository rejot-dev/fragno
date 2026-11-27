---
"@fragno-dev/backoffice-api": patch
---

feat: `pi.agent.watch` sends an agent's subagents and follows their conversations on the agent's own
socket: `subagents` and `subagent` frames say where each subagent stands, and a client `subscribe`s
to a subagent's conversation by its request ID, whose `view` and `ops` frames name it. The
`subagents` frame lists the oldest that wait, those that run, and the newest of the others, with
`older` saying which it leaves out; the `queue` frame counts the waiting ones (`waitingSubagents`);
an app that asked shows by its `appSlug`

feat: `pi.agent.history` takes `subagent`, to page a subagent's conversation
