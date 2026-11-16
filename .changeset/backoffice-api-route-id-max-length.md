---
"@fragno-dev/backoffice-api": patch
---

feat: cap route ids at `AUTOMATION_EVENT_KEY_MAX_LENGTH` (512) characters, since a route's id keys
the state of its failures; shorten longer ids before creating routes.
