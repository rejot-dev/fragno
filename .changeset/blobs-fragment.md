---
"@fragno-dev/blobs": patch
---

feat: add the Blobs fragment, which keeps large files in an S3-compatible bucket such as R2. Callers
move bytes through presigned URLs; the fragment records each blob's size and ETag, tells the
integrator when blobs are stored or deleted, and deletes objects nobody needs. Range reads return
part of a blob's bytes, so callers can look inside large files without downloading them.
