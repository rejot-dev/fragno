---
"@fragno-dev/backoffice-api": patch
---

feat: add the `notify_app` route action, which tells an installed app an event exists with a signed
`{ type: "event", eventId }` app request, and the `app` route steward for routes an app manages.
