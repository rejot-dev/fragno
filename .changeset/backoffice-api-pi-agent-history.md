---
"@fragno-dev/backoffice-api": patch
---

feat!: `pi.agent.messages` reads from an agent's newest compaction or clear on, as the chat does,
with compaction summaries as `compaction` messages; `pi.agent.export` does the same unless passed
`history`. Read a prompt's answer with `pi.prompt.get` instead of paging messages to its entry.
