---
"@fragno-dev/project-connector-fragment": patch
---

feat: `POST /connection-requests` accepts `replace: true` to start over under a name, deleting its
earlier requests; once the new request confirms, its account replaces the name's others.
