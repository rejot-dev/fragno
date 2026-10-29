---
"@fragno-dev/backoffice-api": patch
---

feat: let `models.classify` and `models.extract` read blobs. Their `images` and `files` now name
each file as `{ path }` for a workspace file or `{ blob }` for a blob key, instead of a path string.
