# api-fragment

`@fragno-dev/api-fragment` is a Fragno fragment for configuring outbound HTTP API connections and
executing authenticated requests through server-side routes.

## Auth modes

- `none`
- static bearer token
- OAuth 2.0 authorization-code flow with PKCE
- OAuth 2.0 client-credentials flow

## Server setup

```ts
import { createApiFragment } from "@fragno-dev/api-fragment";

const api = createApiFragment(
  {
    publicBaseUrl: "https://app.example.com/api/integrations",
    allowedBaseUrls: (url) => url.hostname.endsWith(".example.com"),
    onConnectionAvailable: async ({ connectionId, connection }) => {
      console.log("API connection is ready", connectionId, connection.baseUrl);
    },
  },
  fragnoConfig,
);
```

Always provide `allowedBaseUrls` in production so users cannot configure arbitrary server-side
request targets.

## Client usage

```ts
import { createApiFragmentClient } from "@fragno-dev/api-fragment/react";

const api = createApiFragmentClient();

await api.createConnection.mutate(
  {
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
  },
  { pathParams: { slug: "example" } },
);
```

## Routes

Connection management:

- `PUT /connections/:slug` - create a connection with an explicit slug.
- `GET /connections` - list configured connections.
- `GET /connections/:slug` - read one connection.
- `DELETE /connections/:slug` - delete connection, auth secrets, and pending OAuth state.

Auth:

- `GET /connections/:slug/auth/status`
- `POST /connections/:slug/auth/token` - store or replace a bearer token.
- `POST /connections/:slug/auth/oauth/start` - start authorization-code + PKCE.
- `GET /oauth/callback` - complete authorization-code + PKCE.
- `DELETE /connections/:slug/auth`

Requests:

- `POST /connections/:slug/request` - execute an HTTP request against the configured `baseUrl`.

The request route only accepts relative paths. Caller-provided `Authorization` headers are ignored
and replaced with stored connection auth.

## Bearer auth

```ts
await api.createConnection.mutate(
  {
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
  },
  { pathParams: { slug: "example" } },
);

await api.setBearerToken.mutate({ token: "..." }, { pathParams: { slug: "example" } });
```

## Client credentials auth

```ts
await api.createConnection.mutate(
  {
    baseUrl: "https://api.example.com",
    auth: {
      type: "client_credentials",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "...",
      clientSecret: "...",
      tokenEndpointAuthMethod: "client_secret_basic",
      scopes: ["read"],
    },
  },
  { pathParams: { slug: "machine" } },
);
```

The fragment acquires a token on the first API request, stores it with expiry, reuses it while
valid, and refreshes it when it is close to expiring.

## OAuth authorization code auth

```ts
await api.createConnection.mutate(
  {
    baseUrl: "https://api.example.com",
    auth: {
      type: "oauth",
      authorizationEndpoint: "https://auth.example.com/oauth/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "...",
      clientSecret: "...",
      tokenEndpointAuthMethod: "client_secret_basic",
      scopes: ["read"],
    },
  },
  { pathParams: { slug: "oauth-api" } },
);

const start = await api.startOAuth.mutate({}, { pathParams: { slug: "oauth-api" } });
window.location.href = start.authorizationUrl;
```

The callback route stores access/refresh tokens and triggers `onConnectionAvailable` after
successful token exchange.

## Executing requests

```ts
const response = await api.request.mutate(
  {
    method: "GET",
    path: "/v1/profile",
    query: { include: "teams" },
  },
  { pathParams: { slug: "oauth-api" } },
);
```

Response bodies are parsed as JSON when the upstream response has a JSON content type. Other
responses are returned as text. Binary responses are out of scope for the MVP.

## Hooks

- `onConnectionChanged` receives `{ connectionId, connection }`.
- `onConnectionDeleted` receives `{ connectionId, previous }`.
- `onConnectionAvailable` receives `{ connectionId, connection, authMode }` when usable auth is
  present after bearer setup, OAuth callback, or client-credentials token acquisition.

Hook callbacks receive a context object as their second argument: `{ idempotencyKey, hookId }`.

## Security notes

- Use `allowedBaseUrls` in production to avoid SSRF.
- Request paths must be relative; absolute request URLs are rejected.
- Stored auth replaces caller-provided `Authorization` headers.
- Secrets and tokens are stored in the fragment database as JSON/plaintext for MVP.
- OAuth state is one-time use and expires after 10 minutes.
- Do not log secret payloads, authorization headers, refresh tokens, or token endpoint responses.
