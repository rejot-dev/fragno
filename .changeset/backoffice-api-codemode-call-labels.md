---
"@fragno-dev/backoffice-api": patch
---

feat: codemode call subjects have a `tool` kind, which records the tool's `label` and the input
`target` it acted on, such as "Save file" and a path. `call` subjects remain for calls whose input
the tool refused and for calls recorded before this change.
