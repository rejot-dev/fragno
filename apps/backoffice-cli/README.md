# Backoffice CLI

The officially supported command-line client for a local Fragno Backoffice server.

From the repository root:

```bash
pnpm --filter @rejot-dev/backoffice-cli backoffice-cli --help
pnpm --filter @rejot-dev/backoffice-cli backoffice-cli login --open
```

The CLI discovers local Backoffice servers, authenticates through the OAuth device flow, manages
scope-specific credentials, fetches codemode declarations, and runs scoped JavaScript or shell
commands. `backoffice system` prints to stdout by default. When given an output path, it creates a
new owner-only file and refuses to overwrite an existing path.

Set `BACKOFFICE_URL` to select a server, `BACKOFFICE_AUTH_FILE` to override credential storage, or
`BACKOFFICE_OPEN_BROWSER=1` to open the device authorization page during login.
