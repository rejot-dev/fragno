# Pi Fragment CLI (fragno-pi)

Command-line interface for the pi-fragment service. Use it to list sessions, create a session, fetch
details, or send messages.

## Setup

Install dependencies from the repo root:

```bash
pnpm install
```

Run the CLI directly (uses built output if available, otherwise runs from source):

```bash
pnpm --filter @fragno-dev/pi-fragment exec fragno-pi --help
```

Optional: build the CLI first for faster startup:

```bash
pnpm --filter @fragno-dev/pi-fragment build
```

## Global Options

- `-b, --base-url <url>`: Fragment base URL (or `FRAGNO_PI_BASE_URL`)
- `-H, --header <header>`: Extra HTTP header, repeatable (or `FRAGNO_PI_HEADERS`)
- `--timeout <ms>`: Request timeout in ms (default: 15000)
- `--retries <n>`: Retry count (default: 2)
- `--retry-delay <ms>`: Delay between retries (default: 500)
- `--json`: Output raw JSON
- `--debug`: Log request metadata to stderr

## Environment Variables

```bash
export FRAGNO_PI_BASE_URL="https://api.example.com"
export FRAGNO_PI_HEADERS="Authorization: Bearer abc123; X-Client: fragno-pi"
export FRAGNO_PI_TIMEOUT_MS=12000
export FRAGNO_PI_RETRIES=3
export FRAGNO_PI_RETRY_DELAY_MS=250
```

## Examples

List sessions:

```bash
fragno-pi sessions list --limit 10
```

Create a session:

```bash
fragno-pi sessions create --agent reviewer --name "Review Run" --tag alpha --tag beta \
  --metadata '{"priority":2}' --steering-mode all
```

Get session detail (positional or explicit session id):

```bash
fragno-pi sessions get --session session-123
fragno-pi sessions get session-123 --status-only
```

Send a message:

```bash
fragno-pi sessions send-message --session session-123 --text "Hello from CLI"
fragno-pi sessions send-message session-123 --file ./message.txt --done
```

`send-message` is asynchronous. It returns a 202 ACK with status only. Use `sessions get` to fetch
assistant responses once the workflow finishes.

Use headers or env vars for auth:

```bash
fragno-pi -H "Authorization: Bearer abc123" sessions list
```
