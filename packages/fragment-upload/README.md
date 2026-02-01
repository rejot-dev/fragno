# Fragno Fragment

You've created a new [Fragno](https://fragno.dev/) fragment!

## Build

```bash
npm run types:check
npm run build
```

## CLI

The upload fragment ships with a CLI to interact with its HTTP API.

```bash
# From the workspace
pnpm -C packages/fragment-upload build
node packages/fragment-upload/bin/run.js --help
```

```bash
# Use the CLI (base URL points to the mounted upload fragment)
fragno-upload --help
fragno-upload uploads create -b https://host.example.com/api/uploads --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain
fragno-upload uploads transfer -b https://host.example.com/api/uploads -f ./demo.txt --file-key s~Zm9v
fragno-upload files list -b https://host.example.com/api/uploads --prefix s~Zm9v.
fragno-upload files download -b https://host.example.com/api/uploads --file-key s~Zm9v -o ./download.txt
```

Environment defaults:

- `FRAGNO_UPLOAD_BASE_URL`
- `FRAGNO_UPLOAD_HEADERS`
- `FRAGNO_UPLOAD_TIMEOUT_MS`
- `FRAGNO_UPLOAD_RETRIES`
- `FRAGNO_UPLOAD_RETRY_DELAY_MS`

## Next Steps

- Define your routes in `src/index.ts`
- Add framework-specific clients in `src/client/`
- See `AGENTS.md` for detailed development patterns
