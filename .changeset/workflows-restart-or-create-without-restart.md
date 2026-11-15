---
"@fragno-dev/workflows": patch
---

feat: `restartOrCreateInstance` takes `restart: null` to create an instance only when none with its
ID exists, leaving an existing one unchanged whatever its status.
