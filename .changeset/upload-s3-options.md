---
"@fragno-dev/upload": patch
---

feat: the S3-compatible and R2 storage adapters accept a `fetch` option for their signed storage
requests, and a `declaredSize: "maximum"` option that accepts any stored size up to an upload's
declared one, for uploaders that cannot know the size in advance.
