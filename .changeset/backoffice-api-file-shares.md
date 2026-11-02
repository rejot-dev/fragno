---
"@fragno-dev/backoffice-api": patch
---

feat: `shares.create`, `shares.accept`, `shares.list`, and `shares.revoke` share a `/workspace`
folder, or the blobs under a key prefix, with another scope without copying them: once accepted,
that scope reads them at `/shared/<name>/`, under a name it chooses, until either side revokes the
share. A shared folder's files are read as files; shared blobs are read through `blobs.get`,
`blobs.list`, `blobs.read`, and `blobs.createDownloadUrl` with keys under `/shared/<name>/`.
`state.searchFiles` returns a `shared` page when its pattern names a share, and `models.extract` and
`models.classify` read files and blobs under `/shared`.
