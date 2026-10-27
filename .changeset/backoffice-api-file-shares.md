---
"@fragno-dev/backoffice-api": patch
---

feat: `state.share`, `state.acceptShare`, `state.listShares`, and `state.revokeShare` share a
`/workspace` folder with another scope without copying it: once accepted, that scope reads it at
`/shared/<name>/`, under a name it chooses, until either side revokes it. `state.searchFiles`
returns a `shared` page when its pattern names a share, and `models.extract` and `models.classify`
read files under `/shared`.
