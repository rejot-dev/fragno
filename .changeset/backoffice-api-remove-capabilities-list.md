---
"@fragno-dev/backoffice-api": patch
---

feat!: remove the `capabilities.list` operation, the `capabilities.read` permission, and the
`v0/capabilities` export. Use `integrations.discover` and `integrations.list` for connection status;
`hooks.scopes.list` and `HookScopesListOutput` move to `v0/hooks`.
