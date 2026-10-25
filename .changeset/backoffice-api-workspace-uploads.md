---
"@fragno-dev/backoffice-api": patch
---

feat!: remove the `upload.*` operations. Uploads are ordinary workspace files: read them with the
`state.*` operations. File links move to `state.createDownloadLink` and `state.createUploadLink`,
and the `FileLink` and `FileLinkInput` types to `v0/state`.
