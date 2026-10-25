---
"@fragno-dev/upload": patch
---

fix: file-link downloads arrive as attachments named after the file, or after the folder for
archives, and send `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy.
