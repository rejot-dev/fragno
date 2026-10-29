---
"@fragno-dev/backoffice-api": patch
---

feat: a completed `pi.prompt.get` status carries the prompt's `answer`, readable however the agent's
context changes later; read answers with it rather than through `turn.completed`'s `answerEntryId`.
