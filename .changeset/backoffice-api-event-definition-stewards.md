---
"@fragno-dev/backoffice-api": patch
---

feat: event definitions report their `steward`, and packages declare them in
`.marketplace/installation.json` as `eventDefinitions`; `packages.uninstall` also returns
`removedEventDefinitions`. The route steward type `AutomationRouteSteward` is now
`AutomationSteward`.
