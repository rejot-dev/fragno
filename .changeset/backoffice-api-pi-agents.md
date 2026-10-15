---
"@fragno-dev/backoffice-api": patch
---

feat: replace Pi sessions with defined agents. `pi.session.*` operations become `pi.agent.list`,
`pi.agent.get`, and `pi.agent.abort`; prompts and submissions address an `agentName`, `whenBusy`
accepts `followUp`, and prompt receipts report the `whenBusy` that applied. `pi.agent.create`,
`pi.agent.update`, and `pi.agent.delete` define agents and require `pi.manage`.
