---
"@fragno-dev/api-fragment": patch
---

feat: validate connection slugs, paginate connections, report sanitized auth status, resume pending
OAuth links, replace a connection's configuration in place, and restart OAuth consent while
discarding stored tokens. Clearing auth now keeps the connection's auth mode.
