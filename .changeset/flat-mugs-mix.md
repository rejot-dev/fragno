---
"@fragno-dev/core": patch
---

fix: set `workerd` package exports so Cloudflare Workers import the server bundle while server-side
rendering instead of the browser bundle.
