---
"@fragno-dev/upload": patch
---

feat: `POST /uploads` takes `replaceActiveUpload` to abort unfinished uploads of the same file key,
cleaning up what they stored, instead of rejecting the new upload with `UPLOAD_ALREADY_ACTIVE`.
