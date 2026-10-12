---
"@fragno-dev/mcp-fragment": patch
---

fix: forget a registered OAuth client and discovered metadata the server rejects, so the next
consent registers a fresh client instead of reusing the rejected one
