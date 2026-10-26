---
"@fragno-dev/backoffice-api": patch
---

feat: routes report their `steward`, `members` or the package that manages them, instead of a
`managedBy` label callers set; `router.create` and `router.update` no longer accept `managedBy`, so
packages declare their routes in `.marketplace/installation.json` instead. Package installs approve
the release's declared `permissions`. `packages.ls` lists installation records with their settings,
and `packages.get` and `packages.uninstall` are new. Pi agents' `managedBy` is now typed
`PiAgentMarketplaceManagedBy`.
