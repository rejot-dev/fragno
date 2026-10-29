---
"@fragno-dev/project-connector-fragment": patch
---

fix: confirm a connection request the gateway no longer knows as expired instead of failing with
HTTP 502, so a new OAuth attempt can replace it
