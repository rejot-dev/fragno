---
"@fragno-dev/backoffice-api": patch
---

feat!: Pi agent definitions report their `steward` (`members`, `package`, or `backoffice` for
built-in agents) instead of `managedBy`, packages declare agents in `.marketplace/installation.json`
as `agents`, and `packages.uninstall` returns `removedAgents`. Read `steward` where you read
`managedBy`, and declare a package's agents instead of passing `managedBy` to `pi.agent.create` or
`pi.agent.update`, which now refuse it.
