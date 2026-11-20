# Leyway CLI

The officially supported command-line client for a Leyway server.

From the repository root:

```bash
pnpm leyway --help
pnpm leyway login --open
pnpm leyway scopes
```

The CLI discovers local Leyway servers, authenticates through the OAuth device flow, manages
scope-specific credentials, fetches codemode declarations, runs scoped JavaScript or shell commands,
and transfers files between the local filesystem and scoped Leyway filesystems. It can also listen
to the scoped Automations mutation stream as newline-delimited JSON, reconnecting with the last
observed versionstamp when the server rotates the stream. Uploads target `/workspace`; downloads
also support read-only paths such as `/static`. `leyway system` prints to stdout by default. When
given an output path, it creates a new owner-only file and refuses to overwrite an existing path.

Run `leyway scopes` to print the exact scope arguments available to the authenticated user.
Organization scope arguments always use the organization **slug**, never its internal ID:

```text
org:<organization-slug>
user:<user-id>
app:<owner>:<app-id>
project:<owner>:<project-id>
```

An `<owner>` is `org:<organization-slug>` or `user:<user-id>`; a project's owner may also be an app,
e.g. `project:app:org:<organization-slug>:<app-id>:<project-id>`.

For an organization with the slug `acme`, commands look like:

```bash
leyway listen org:acme
leyway listen org:acme --after-versionstamp 000000000000000000000000
leyway upload org:acme ./report.pdf /workspace/reports/report.pdf
leyway download org:acme /workspace/reports/report.pdf ./report.pdf
leyway download org:acme /static/SYSTEM.md ./SYSTEM.md
```

`leyway login` waits for approval of the sign-in it requests. To ask for approval in one process and
wait in another, as an agent that shows the URL in chat does, run `leyway login --start`, then
`leyway login --wait`; running `--wait` again resumes the same approval.

Set `LEYWAY_URL` to select a server, `LEYWAY_AUTH_FILE` to override credential storage, or
`LEYWAY_OPEN_BROWSER=1` to open the device authorization page during login.

The credential file keeps one sign-in per server, so signing in to one server, such as another
worktree's dev server or Leyway Cloud, keeps the others signed in.

## MCP

Sign in with `leyway login --open` and configure your MCP client to launch `leyway mcp` over stdio.
The command uses the sign-in saved by the CLI, including its OAuth device approval and refresh flow.
Use `--base-url` or `LEYWAY_URL` to select the same server you signed in to.

```json
{
  "mcpServers": {
    "leyway": {
      "command": "leyway",
      "args": ["mcp"]
    }
  }
}
```

The `codemode` tool starts each run in your personal workspace. Read the Codemode guide at
`leyway://codemode/SYSTEM.md` for the available tools and context handles. Use `account.orgsList()`
to find organization IDs, then call `context.org(organizationId).projects.list({})` to list that
organization's projects.
