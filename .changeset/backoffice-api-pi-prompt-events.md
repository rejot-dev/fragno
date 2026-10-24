---
"@fragno-dev/backoffice-api": patch
---

feat!: remove `pi.prompt.run` and `pi.submission.get`, and drop the conversation `view` from
`pi.agent.get`'s output. Submit prompts with `pi.prompt.submit` and wait for the prompt's `pi` turn
events instead.
