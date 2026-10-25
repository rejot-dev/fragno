# Moving files between Backoffice and a sandbox

The sandbox's `/workspace` is its own disk, separate from the Backoffice `/workspace`, and the
sandbox holds no Backoffice credentials. Move files with **file links**: `state.createDownloadLink`
and `state.createUploadLink` (see "/static/codemode/providers/state.d.ts", which lists their limits)
return a temporary URL for sandbox commands to `curl`, so file bytes stay out of command text and
output. Pass `link.url` to the command exactly as returned: its host may resolve only inside
sandboxes.

A link reaches the workspace of the scope that created it, and any sandbox can use it: create it
with `context.project(projectId).state` or `context.user(userId).state` to move that scope's files.

**Pull** a folder in:

```js
async () => {
  const link = await state.createDownloadLink({ path: "/workspace/data/" });
  return await sandbox.executeCommand({
    sandboxId: "dev",
    command: `set -o pipefail; mkdir -p data && curl -sS --fail-with-body '${link.url}' | tar -x -C data`,
    timeoutMs: 120000,
  });
};
```

**Push** the task's outputs back:

```js
async () => {
  const link = await state.createUploadLink({ path: "/workspace/results/" });
  return await sandbox.executeCommand({
    sandboxId: "dev",
    command: `set -o pipefail; tar -ch -C out . | curl -sS --fail-with-body -H 'Expect:' -T - '${link.url}'`,
    timeoutMs: 120000,
  });
};
```

- **Shape:** a path ending in `/` or containing `*` or `?` links many files as an uncompressed tar
  archive (`format: "tar"`), with entry names relative to `link.root`. Any other path links one file
  (`format: "file"`): the same `curl` flags with `-o name` read it and with `-T name` write it.
- **Pushes are all-or-nothing:** every archive entry must match the link's glob. One stray entry,
  symlink, or duplicate rejects the whole archive and writes nothing; `tar -h` stores symlink
  targets instead of links. Pushed files replace existing files at the same paths without warning.
- **Push outputs only:** archive the specific files or folder the task produced. Pushes are capped
  per archive and per file; when a push exceeds a cap, narrow it to the outputs, and when the task
  truly needs more, ask the user before pushing in parts.
- **Pulls page:** when more files match than one archive holds, the response has an `X-Next-Cursor`
  header; fetch `<url>?cursor=<value>` until the header is absent.
- **Links are bearer URLs** until they expire: anyone holding one can use it. Create each link right
  before its command, link the narrowest folder or glob the task needs, and use each URL only inside
  its command.

`pipefail` and `--fail-with-body` make a rejected request fail the command with Backoffice's JSON
error, such as `{"message":"…","code":"INVALID_REQUEST"}`, in stdout: read its message and correct
the request. Exit 6 or 7 (cannot resolve or connect) or an HTTP 5xx without such a message means
sandboxes cannot reach Backoffice in this deployment: report that and stop moving files.

**Complete when** every pull fetched its last page (no `X-Next-Cursor`), and every push printed
`{"fileCount":…,"sizeBytes":…}` with the expected file count and one pushed file reads back in
Backoffice.
