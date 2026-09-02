# Backoffice CLI

The officially supported command-line client for a local Fragno Backoffice server.

From the repository root:

```bash
pnpm --filter @rejot-dev/backoffice-cli backoffice-cli --help
pnpm --filter @rejot-dev/backoffice-cli backoffice-cli login --open
pnpm --filter @rejot-dev/backoffice-cli backoffice-cli scopes
```

The CLI discovers local Backoffice servers, authenticates through the OAuth device flow, manages
scope-specific credentials, fetches codemode declarations, runs scoped JavaScript or shell commands,
and transfers files between the local filesystem and scoped Backoffice filesystems. Uploads target
`/workspace`; downloads also support read-only paths such as `/static`. `backoffice system` prints
to stdout by default. When given an output path, it creates a new owner-only file and refuses to
overwrite an existing path.

Run `backoffice scopes` to print the exact scope arguments available to the authenticated user.
Organization scope arguments always use the organization **slug**, never its internal ID:

```text
org:<organization-slug>
project:<organization-slug>:<project-id>
```

For an organization with the slug `acme`, commands look like:

```bash
backoffice upload org:acme ./report.pdf /workspace/reports/report.pdf
backoffice download org:acme /workspace/reports/report.pdf ./report.pdf
backoffice download org:acme /static/SYSTEM.md ./SYSTEM.md
```

Set `BACKOFFICE_URL` to select a server, `BACKOFFICE_AUTH_FILE` to override credential storage, or
`BACKOFFICE_OPEN_BROWSER=1` to open the device authorization page during login.
