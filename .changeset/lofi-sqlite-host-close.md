---
"@fragno-dev/lofi": patch
---

fix: a closing SQLite replica host now waits for its replica before closing its channels, so a
status the replica reports while closing no longer throws "BroadcastChannel is closed".
