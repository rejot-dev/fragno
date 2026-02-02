# Upload Example

Local development runs on HTTP by default. If your environment forces HTTPS or you see ALPN
negotiation errors, you can run Vite over HTTPS with a local certificate.

## Modes

This example supports two upload modes. You can enable either one or both at the same time.

- Direct multipart (S3-compatible): the browser uploads directly to S3 using signed URLs. Configure
  `UPLOAD_S3_*` env vars to enable the `/direct` page.
- Proxy streaming (filesystem): the app server streams bytes to local disk. Configure
  `UPLOAD_PROXY_DIR` to control where files are stored for the `/proxy` page.

`.env.example` includes both sets of variables so future readers can see the full setup.

## Local S3 (MinIO)

Direct uploads need an S3-compatible endpoint. This example includes a MinIO compose file that
bootstraps a local `uploads` bucket.

```bash
cd example-apps/upload-example
docker compose up -d
cp .env.example .env
```

MinIO runs at `http://localhost:9000` with a console at `http://localhost:9001` (login: `minioadmin`
/ `minioadmin`).

You can also override the direct upload multipart threshold by setting
`UPLOAD_S3_MULTIPART_THRESHOLD_BYTES`. For example, `6291456` (6 MiB) will force multipart uploads
for files larger than ~6 MiB so you can exercise multipart flows locally.

Additional optional tuning variables (see `.env.example`) let you test edge cases:

- `UPLOAD_S3_MULTIPART_PART_SIZE_BYTES`, `UPLOAD_S3_DIRECT_UPLOAD_THRESHOLD_BYTES`
- `UPLOAD_S3_MAX_SINGLE_UPLOAD_BYTES`, `UPLOAD_S3_MAX_MULTIPART_UPLOAD_BYTES`
- `UPLOAD_S3_UPLOAD_EXPIRES_IN_SECONDS`, `UPLOAD_S3_SIGNED_URL_EXPIRES_IN_SECONDS`
- `UPLOAD_S3_MAX_METADATA_BYTES`
- `UPLOAD_PROXY_UPLOAD_EXPIRES_IN_SECONDS`

## Run

From the repo root:

```bash
pnpm -C example-apps/upload-example dev
```

## Proxy storage directory

Proxy uploads are written to a local directory. By default this uses `~/.fragno/upload-example`. You
can override it by setting `UPLOAD_PROXY_DIR`, for example:

```bash
UPLOAD_PROXY_DIR="$HOME/Library/Application Support/fragno/upload-example" \
  pnpm -C example-apps/upload-example dev
```

You can also add it to a local env file (see `.env.example`).

## Local HTTPS (optional)

Set `UPLOAD_EXAMPLE_HTTPS=1` to enable HTTPS for this app. It uses `@vitejs/plugin-basic-ssl`, which
generates a self-signed certificate on the fly. Your browser may show a warning unless you trust the
cert.

```bash
UPLOAD_EXAMPLE_HTTPS=1 pnpm -C example-apps/upload-example dev
```
