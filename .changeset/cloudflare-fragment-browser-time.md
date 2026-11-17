---
"@fragno-dev/cloudflare-fragment": patch
---

feat: report the browser time Cloudflare bills each Browser Run Quick Action for. JSON Quick Action
services now return `{ result, browserMsUsed }` instead of the bare result, `pdf` and `screenshot`
keep Cloudflare's `x-browser-ms-used` header, and the extract route passes it on as that header. A
response without it fails. `BROWSER_MS_USED_HEADER` and `readBrowserMsUsed` read it.
