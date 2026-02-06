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

3. Run the server (use the development condition so workspace packages resolve to source):

```bash
NODE_OPTIONS=--conditions=development node --import tsx src/mod.ts serve
```

The server listens on `http://localhost:3000` and logs each fragment mount route and its outbox
endpoint. Use the logged `/_internal/outbox` URLs with Lofi or the `fragno-lofi` CLI.

## Useful commands

```bash
node --import tsx src/mod.ts user --help
node --import tsx src/mod.ts post --help
node --import tsx src/mod.ts comment --help
node --import tsx src/mod.ts rating --help
```
