# Graft SQLite POC

A Node.js CLI that seeds a local SQLite database, pushes it to S3-compatible storage through Graft,
and clones a remote log into a separate local database. Requires Node.js >=24.11.0 and the native
`sqlite-graft` extension for your platform.

## Configuration

Export these environment variables before running:

- `R2_CELLD_BACKOFFICE_AWS_ACCESS_KEY_ID`
- `R2_CELLD_BACKOFFICE_AWS_SECRET_ACCESS_KEY`
- `R2_CELLD_BACKOFFICE_AWS_REGION`
- `R2_CELLD_BACKOFFICE_S3_ENDPOINT`
- `R2_CELLD_BACKOFFICE_CELLD_BUCKET` (bucket name or `s3://` URI)

The CLI maps credentials to the AWS environment variables consumed by Graft and writes its
configuration before loading the native extension. Configuration and local databases live in
`apps/graft-poc/.graft/`, which is gitignored. `GRAFT_POC_DATA_DIR` overrides the local database
directory; seed and clone use separate directories by default.

## Run

From the repository root:

```sh
pnpm --filter @fragno-private/graft-poc seed
pnpm --filter @fragno-private/graft-poc clone REMOTE_LOG_ID
```

Find the remote log ID in the seed command's Graft diagnostics. Alternatively, set
`GRAFT_REMOTE_LOG_ID` before running clone without an argument. Each seed run adds an event. Both
commands print recent rows and Graft version, info, and status.

## Check and build

```sh
pnpm exec turbo build types:check --filter=@fragno-private/graft-poc --output-logs=errors-only
node apps/graft-poc/dist/graft-sqlite-poc.js seed
node apps/graft-poc/dist/graft-sqlite-poc.js clone REMOTE_LOG_ID
```

Replication requires real storage credentials; these commands write to the configured bucket under
the `graft-sqlite-poc` prefix.
