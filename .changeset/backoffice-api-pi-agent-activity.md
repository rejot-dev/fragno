---
"@fragno-dev/backoffice-api": patch
---

feat: `pi.agent.activity` reads the tools an agent's conversation, or one of its subagents', ran,
oldest first and including those still running, with each codemode run's calls: the skills it
loaded, the files it read, and the integration actions it ran. `codemodeCallsSchema` and
`codemodeCallSubjectSchema` describe those calls.
