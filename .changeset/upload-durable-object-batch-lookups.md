---
"@fragno-dev/upload": patch
---

fix: Publish prepared batches of 100 or more uploads on Durable Object SQLite, which binds at most
100 parameters per statement.
