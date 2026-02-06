# fragno-db-usage-drizzle

Example app showing `@fragno-dev/db` with Drizzle + PGlite, plus multiple fragments (auth, comment,
rating, workflows).

## Dev setup

1. Install deps from repo root:

```bash
pnpm install
```

2. Generate schema + init test database (if needed):

```bash
pnpm exec tsx ./src/init-tests.ts
```

3. Build the CLI:

```bash
pnpm exec turbo build --filter=./example-apps/fragno-db-usage-drizzle --output-logs=errors-only
```

4. Run the server:

```bash
node example-apps/fragno-db-usage-drizzle/bin/run.js serve
```

The server listens on `http://localhost:3000` and logs each fragment mount route and its outbox
endpoint. Use the logged `/_internal/outbox` URLs with Lofi or the `fragno-lofi` CLI.

## Useful commands

```bash
node example-apps/fragno-db-usage-drizzle/bin/run.js user --help
node example-apps/fragno-db-usage-drizzle/bin/run.js post --help
node example-apps/fragno-db-usage-drizzle/bin/run.js comment --help
node example-apps/fragno-db-usage-drizzle/bin/run.js rating --help
```
