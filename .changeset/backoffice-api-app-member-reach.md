---
"@fragno-dev/backoffice-api": patch
---

feat: apps request `requestedMemberReach` and installations carry `memberReach`, `{ kind: "none" }`
or `{ kind: "consenting" }`: an organization's installation may reach the personal workspaces of
members who let the app in, acting for them with its granted permissions. `apps.install` defaults it
to none; `apps.installations.update` requires it.
