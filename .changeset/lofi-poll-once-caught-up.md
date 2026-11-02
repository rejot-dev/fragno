---
"@fragno-dev/lofi": patch
---

feat: add `pollOnceCaughtUp` to SQLite replicas, which take turns streaming their catch-up and poll
from then on, so replicas opened beside a page's own leave its connections free
