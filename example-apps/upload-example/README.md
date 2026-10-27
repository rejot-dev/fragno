# Upload Example

A React Router app that stores files with the upload fragment. Files stream through the app server
into its PGlite database; the page lists files by key prefix, uploads with progress, and downloads
them back.

## Run

From the repo root:

```bash
pnpm -C example-apps/upload-example dev
```

Set `UPLOAD_MAX_FILE_BYTES` to change the largest file the fragment stores (default: 10 MiB).

The dev server runs over HTTPS with a self-signed certificate from `@vitejs/plugin-basic-ssl`, so
your browser may warn until you trust it.
