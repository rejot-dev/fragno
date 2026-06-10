# mcp-fragment

A DB-backed Fragno fragment for calling MCP tools over Streamable HTTP.

This fragment is a client for one or more remote MCP servers. It stores server configuration and
auth state in the fragment database, then connects to MCP servers per operation to list tools or
call a tool. It supports MCP **tools** only; prompts, resources, roots, sampling, and elicitation
are out of scope for this package.

## Usage

```ts
import { createMcpFragment } from "@fragno-dev/mcp-fragment";

const fragment = createMcpFragment(
  {
    publicBaseUrl: "https://app.example.com/mcp",
    // Optional SSRF/tenant allow-list hook.
    allowedEndpointUrls: (url) => url.protocol === "https:",
  },
  {
    databaseAdapter: yourDatabaseAdapter,
  },
);
```

## CLI

The package ships a small local CLI for trying remote MCP servers from disk-backed SQLite storage.
It runs the MCP fragment locally, migrates the SQLite database on startup when needed, and stores
data under `~/.fragno/mcp-fragment` by default.

```bash
# Terminal 1: start the local fragment server.
fragno-mcp serve

# From this repository, run the same command through pnpm:
pnpm --filter @fragno-dev/mcp-fragment cli -- serve

# Terminal 2: register a remote Streamable HTTP MCP server.
fragno-mcp add my-tools https://mcp.example.com/mcp

# Start OAuth for that server. Keep `serve` running so it can handle the callback.
fragno-mcp oauth my-tools --scope tools

# Check auth state.
fragno-mcp status my-tools

# Retrieve the remote MCP tools.
fragno-mcp tools my-tools
```

Defaults:

- local base URL: `http://127.0.0.1:3927`
- fragment mount route: `/api/mcp-fragment`
- SQLite data directory: `~/.fragno/mcp-fragment`

Useful options:

```bash
fragno-mcp serve --port 4000 --data-dir ./mcp-data
fragno-mcp oauth my-tools --client-id ... --client-secret ... --no-open
fragno-mcp tools my-tools --json
```

For `add`, the CLI registers the server with `auth: { type: "none" }`; run `oauth` afterwards for
OAuth-backed servers. Keep `fragno-mcp serve` running while authorizing so the remote OAuth provider
can redirect back to `/api/mcp-fragment/oauth/callback`.

## Client helpers

```ts
import { createMcpFragmentClients } from "@fragno-dev/mcp-fragment";

const mcp = createMcpFragmentClients({ baseUrl: "/mcp" });

// Hooks
mcp.useServers;
mcp.useServer;
mcp.useTools;

// Mutators
mcp.createServer;
mcp.setToken;
mcp.startOAuth;
mcp.deleteAuth;
mcp.callTool;
```

## Routes

Server management:

- `POST /servers` - register an MCP server.
- `GET /servers` - list registered servers.
- `GET /servers/:slug` - get one registered server.
- `DELETE /servers/:slug` - delete a server and its auth/cache state.

Auth:

- `GET /servers/:slug/auth/status` - report auth mode and whether usable auth is stored.
- `POST /servers/:slug/auth/token` - store or replace a bearer token.
- `POST /servers/:slug/auth/start` - start OAuth authorization-code + PKCE.
- `GET /oauth/callback` - complete OAuth authorization-code + PKCE.
- `DELETE /servers/:slug/auth` - delete auth state and switch the server to `none` auth.

Tools:

- `GET /servers/:slug/tools` - connect to the MCP server and list tools.
- `POST /servers/:slug/tool` - connect to the MCP server and call one tool.

## Registering servers

No auth:

```ts
await mcp.createServer.mutate({
  slug: "local-tools",
  endpointUrl: "https://mcp.example.com/mcp",
  auth: { type: "none" },
});
```

Bearer token auth:

```ts
await mcp.createServer.mutate({
  slug: "private-tools",
  endpointUrl: "https://mcp.example.com/mcp",
  auth: { type: "bearer", token: "..." },
});

// Later replacement:
await mcp.setToken.mutate({ token: "new-token" }, { pathParams: { slug: "private-tools" } });
```

Client credentials auth:

```ts
await mcp.createServer.mutate({
  slug: "machine-tools",
  endpointUrl: "https://mcp.example.com/mcp",
  auth: {
    type: "client_credentials",
    clientId: "...",
    clientSecret: "...",
    scopes: ["tools"],
  },
});
```

The fragment acquires an access token before the first tool operation, stores it with its expiry,
and reuses it until it is close to expiring.

OAuth auth:

```ts
await mcp.createServer.mutate({
  slug: "oauth-tools",
  endpointUrl: "https://mcp.example.com/mcp",
  auth: { type: "oauth" },
});
```

## OAuth flow

The OAuth flow uses the official MCP TypeScript SDK auth APIs with a fragment-owned DB-backed
`OAuthClientProvider`.

### 1. Start authorization

Call `POST /servers/:slug/auth/start`:

```ts
const start = await mcp.startOAuth.mutate(
  {
    // Optional OAuth scope string.
    scope: "tools",
    // Optional static/pre-registered OAuth client. Persisted for the callback.
    clientId: "...",
    clientSecret: "...",
  },
  { pathParams: { slug: "oauth-tools" } },
);

window.location.href = start.authorizationUrl;
```

The route:

1. Loads the MCP server by slug.
2. Creates a DB-backed SDK `OAuthClientProvider` for that server.
3. Calls the SDK `auth(...)` helper.
4. Lets the SDK discover OAuth protected-resource metadata and authorization-server metadata.
5. Lets the SDK perform dynamic client registration when required.
6. Generates PKCE verifier/challenge and an authorization URL.
7. Stores the OAuth state, PKCE verifier, fragment-owned redirect URI, requested scope, discovery
   state, and client information in the fragment DB/secret tables.
8. Returns `{ authorizationUrl, state }`.

### 2. User authorizes with the OAuth server

Redirect the browser to `authorizationUrl`. The OAuth server eventually redirects back to the
fragment callback URL with `code` and `state` query parameters.

### 3. Complete callback

The mounted fragment handles:

```http
GET /oauth/callback?code=...&state=...
```

The callback route:

1. Validates that `code` and `state` exist.
2. Loads the pending one-time OAuth state from the DB.
3. Rejects missing, expired, or already consumed states.
4. Recreates the DB-backed SDK `OAuthClientProvider` for the matching server.
5. Calls SDK `auth(...)` with the authorization code.
6. Lets the SDK exchange the code + PKCE verifier for tokens.
7. Stores access token, refresh token, token type, scope, and expiry in stored secret payloads.
8. Marks the OAuth state as consumed only after successful token exchange.
9. Returns `{ authenticated: true, mode: "oauth" }`.

### 4. Tool operations use stored OAuth tokens

After callback completion, `GET /servers/:slug/tools` and `POST /servers/:slug/tool` read the stored
OAuth token payload from the DB and send the access token as a bearer token when connecting to the
MCP server.

The fragment still connects per operation. MCP session IDs are used only inside a single operation
by the SDK transport and are not stored or reused across requests.

## Calling tools

```ts
const tools = await mcp.useTools.store({ pathParams: { slug: "oauth-tools" } });

const result = await mcp.callTool.mutate(
  {
    name: "echo",
    arguments: { text: "hello" },
    timeoutMs: 10_000,
  },
  { pathParams: { slug: "oauth-tools" } },
);
```

## Security notes

- Always provide `allowedEndpointUrls` in production to prevent SSRF.
- Auth payloads and OAuth state are stored as JSON/plaintext in the fragment database; use
  database-level controls if those values need protection.
- OAuth state is one-time use and expires after 10 minutes.
- Deleting a server deletes stored auth, pending OAuth state, and cached tools.
- `DELETE /servers/:slug/auth` deletes auth state and switches that server back to `none` auth.

## Build

```bash
pnpm run types:check
pnpm run build
```

## Test

```bash
pnpm run test
```
