---
name: using-prepared-uploads
description:
  Manage prepared upload lifecycles. Use when code must collect, read, commit, or discard a
  FileUpload result.
---

# Using Prepared Uploads

Treat every prepared upload as a lifecycle: collect one reference, consume it in the matching scope,
then commit or discard it.

# Collect

When composing generated Backoffice UI:

- Read `/static/skills/generating-backoffice-uis/SKILL.md` and its component catalog.
- Set `FileUpload.scope` to `{ kind: "current" }` when the upload belongs to the workflow's current
  Backoffice context. The renderer resolves it to the authenticated org, project, or user scope.
- Initialize the bound value to `null` and bind `FileUpload.value` with
  `{ "$bindState": "/response/attachment" }`.
- Submit the response through one `WorkflowEventButton`.

State receives one serializable prepared-upload reference. It contains no browser `File`, bytes,
base64, URL, or generated storage policy.

# Consume

Read `/static/codemode/providers/upload.d.ts` before authoring lifecycle operations. Use the
submitted prepared-upload reference as the `file` input:

- `upload.readPrepared({ file, encoding: "utf8" })` returns textual content as `text`.
- `upload.readPrepared({ file, encoding: "bytes" })` returns binary content as `bytes`; pass those
  bytes directly to binary consumers.
- Use `encoding: "base64"` only when the consumer requires base64 text; the result is returned as
  `base64`, not raw bytes.
- `upload.commitPrepared({ file })` makes the file persistent.
- `upload.discardPrepared({ file })` deletes a temporary prepared upload.

Use the provider scoped to the reference: the current provider when the upload belongs to the
current workflow context, or the matching `context.org(...)`, `context.project(...)`, or
`context.user(...)` provider for an explicitly different scope.

# Durable completion

Keep lifecycle provider calls inside `step.do`. A workflow that reads a temporary upload reaches
either `commitPrepared` or `discardPrepared` in a later durable step.

**Complete when** the event payload contains one prepared-upload reference, every upload call uses
that exact reference in its matching scope, and the workflow reaches commit or discard.
