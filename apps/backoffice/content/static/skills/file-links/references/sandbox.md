# Moving files between Backoffice and a sandbox

The sandbox's `/workspace` is its own disk, separate from the Backoffice `/workspace`, and the
sandbox holds no Backoffice credentials. Sandbox commands `curl` file links, so file bytes stay out
of command text and output: the link's `path` names the Backoffice files, the command the sandbox's.
Any sandbox can use a link, whichever scope created it.

**Pull** a folder in:

```js
async () => {
  const link = await state.createDownloadLink({ path: "/workspace/data/" });
  return await sandbox.executeCommand({
    sandboxId: "dev",
    command: `set -o pipefail; mkdir -p data && curl -sS --fail-with-body '${link.sandboxUrl}' | tar -x -C data`,
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
    command: `set -o pipefail; tar -ch -C out . | curl -sS --fail-with-body -H 'Expect:' -T - '${link.sandboxUrl}'`,
    timeoutMs: 120000,
  });
};
```

A single-file link takes the same `curl` flags, with `-o name` to read the file and `-T name` to
write it.

- **Pushes are all-or-nothing:** every archive entry must match the link's glob. One stray entry,
  symlink, or duplicate rejects the whole archive and writes nothing; `tar -h` stores symlink
  targets instead of links. Pushed files replace existing files at the same paths without warning.
- **Push outputs only:** archive the specific files or folder the task produced. Pushes are capped
  per archive and per file; when a push exceeds a cap, narrow it to the outputs, and when the task
  truly needs more, ask the user before pushing in parts.
- **Pulls page:** fetch `<sandboxUrl>?cursor=<value>` until the response has no `X-Next-Cursor`
  header.
- **Use each URL only inside its command.**

`pipefail` and `--fail-with-body` make a rejected request fail the command with Backoffice's JSON
error, such as `{"message":"…","code":"INVALID_REQUEST"}`, in stdout: read its message and correct
the request. Exit 6 or 7 (cannot resolve or connect) or an HTTP 5xx without such a message means
sandboxes cannot reach Backoffice in this deployment: report that and stop moving files.

**Complete when** every pull fetched its last page (no `X-Next-Cursor`), and every push printed
`{"fileCount":…,"sizeBytes":…}` with the expected file count and one pushed file reads back in
Backoffice.
