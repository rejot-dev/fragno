---
name: file-links
description:
  "File links: temporary URLs that download or upload Backoffice workspace files without
  credentials. Use when someone wants a link to download workspace files, from one file to the whole
  workspace, a link for a service to upload files, or to move files between Backoffice and a
  sandbox."
---

# File links

A file link is a **bearer URL** to files in one scope's Backoffice workspace: anyone holding it can
use it until it expires, after 15 minutes by default and an hour at most. `state.createDownloadLink`
links files to read and `state.createUploadLink` files to write;
"/static/codemode/providers/state.d.ts" lists their limits.

- **Path:** the link's `path` names Backoffice workspace files, the ones `state.readFile` reads. A
  link reaches the workspace of the scope that created it: create it with
  `context.project(projectId).state` or `context.user(userId).state` for that scope's files.
- **Shape:** a path ending in `/` or containing `*` or `?` links many files as an uncompressed tar
  archive (`format: "tar"`) with entry names relative to `link.root`, and `/workspace/` links the
  whole workspace. Any other path links one file (`format: "file"`).
- **Pages:** one archive holds at most 500 files. When more match, its response has an
  `X-Next-Cursor` header, and `<url>?cursor=<value>` returns the next files.
- **Addresses:** `link.url` is Backoffice's public address, for people and services; a browser
  downloads it under the file's own name. `link.sandboxUrl` is for sandbox commands; its host may
  resolve only inside sandboxes. Pass either exactly as returned.

Link the narrowest folder or glob the task needs, and create each link right before it is used.

## Share files

1. Match the path to the files the person needs. A browser downloads only an archive's first page,
   so when `state.glob` finds more than 500 files under a folder, link its subfolders separately.
   **Complete when** each planned link matches at most 500 files.
2. Create the links with `state.createDownloadLink`, or `state.createUploadLink` for a service that
   sends files with an HTTP `PUT`, such as `curl -T`. A person uploads through a generated form's
   `ui.fileUpload` instead (see the generating-backoffice-uis skill).

   ```js
   async () => await state.createDownloadLink({ path: "/workspace/", expiresInSeconds: 3600 });
   ```

   **Complete when** the person has every `link.url`, when it expires, and that anyone holding it
   can use it until then.

## Move files with a sandbox

Read `/static/skills/file-links/references/sandbox.md` before a sandbox command pulls or pushes
Backoffice files.
