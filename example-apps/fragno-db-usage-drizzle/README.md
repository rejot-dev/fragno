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

## Shell scripts

Convenience shell scripts for interacting with the API via HTTP:

### Add a rating

```bash
# Add an upvote (default)
./scripts/add-rating.sh <reference>

# Add a downvote
./scripts/add-rating.sh <reference> -1

# Custom rating value
./scripts/add-rating.sh <reference> 5
```

### Create a comment

```bash
# Create a top-level comment
./scripts/create-comment.sh "Comment Title" "Comment content" <postReference> <userReference>

# Create a nested comment (reply)
./scripts/create-comment.sh "Reply Title" "Reply content" <postReference> <userReference> <parentId>
```

### Configuration

Both scripts support environment variables for customization:

- `BASE_URL`: Server base URL (default: `http://localhost:3000`)
- `RATING_MOUNT`: Rating fragment mount route (default: `/api/fragno-db-rating`)
- `COMMENT_MOUNT`: Comment fragment mount route (default: `/api/fragno-db-comment`)

Example:

```bash
BASE_URL=http://localhost:8080 ./scripts/add-rating.sh my-reference-id
```
