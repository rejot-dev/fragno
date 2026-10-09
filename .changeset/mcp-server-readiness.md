---
"@fragno-dev/mcp-fragment": patch
---

Add the `onServerReadinessChanged` hook, which receives `{ serverId, ready }` when a write changes
whether stored auth can authorize operations. Tokens the server rejects during an operation are now
removed from storage, so status reports that consent is required instead of `authorized`.
