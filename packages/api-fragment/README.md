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
import { createApiFragment } from "@fragno-dev/api-fragment/server";

const oauthRedirectUri = "https://app.example.com/api/integrations/oauth/callback";
const api = createApiFragment(
  {
    allowedBaseUrls: (url) => url.hostname.endsWith(".example.com"),
    allowedOAuthRedirectUris: (url) => url.toString() === oauthRedirectUri,
    onConnectionAvailable: async ({ connectionId, connection }) => {
      console.log("API connection is ready", connectionId, connection.baseUrl);
    },
  },
  fragnoConfig,
);
```

Always provide `allowedBaseUrls` in production so users cannot configure arbitrary server-side
request targets. OAuth start is denied unless `allowedOAuthRedirectUris` explicitly accepts the
callback URL.

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
- `POST /connections/:slug/auth/oauth/start` - start authorization-code + PKCE with an explicit
  `redirectUri` query parameter.
- `GET /oauth/callback` - complete authorization-code + PKCE.
- `DELETE /connections/:slug/auth`

Requests:

- `POST /connections/:slug/request` - execute an HTTP request against the configured `baseUrl`.

Webhook endpoints:

- `PUT /webhooks/endpoints/:endpointId` - create or replace an endpoint.
- `GET /webhooks/endpoints/:endpointId/events` - answer configured GET verification challenges.
- `POST /webhooks/endpoints/:endpointId/events` - answer configured POST verification challenges or
  accept a delivery.

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

const start = await api.startOAuth.mutate(
  {},
  {
    pathParams: { slug: "oauth-api" },
    query: { redirectUri: oauthRedirectUri },
  },
);
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

## Webhook verification challenges

Webhook verification runs after endpoint authentication and before delivery ID extraction. A matched
challenge returns synchronously and does not trigger `onWebhookReceived`.

```ts
await api.createWebhookEndpoint.mutate(
  {
    name: "Slack",
    status: "active",
    verification: {
      type: "challenge",
      method: "POST",
      when: {
        type: "equals",
        source: { type: "jsonBodyPath", path: ["type"] },
        value: "url_verification",
      },
      response: {
        type: "echoText",
        source: { type: "jsonBodyPath", path: ["challenge"] },
      },
    },
    deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
    auth: {
      type: "hmac",
      secret: "signing-secret",
      algorithm: "sha256",
      signature: {
        location: "header",
        name: "x-slack-signature",
        encoding: "hex",
        prefix: "v0=",
      },
      signedPayload: {
        type: "timestampedBody",
        prefix: "v0:",
        timestampHeader: "x-slack-request-timestamp",
        delimiter: ":",
        toleranceSeconds: 300,
      },
    },
  },
  { pathParams: { endpointId: "slack" } },
);
```

Request value sources can read a header, query parameter, or JSON body path. Challenge predicates
can require that a value is present or equals a configured string. `echoText` responds with the
selected value as `text/plain`.

## Hooks

- `onConnectionChanged` receives `{ connectionId, connection }`.
- `onConnectionDeleted` receives `{ connectionId, previous }`.
- `onConnectionAvailable` receives `{ connectionId, connection, authMode }` when usable auth is
  present after bearer setup, OAuth callback, or client-credentials token acquisition.
- `onWebhookReceived` receives the authenticated webhook payload and its derived delivery ID.

Durable hook callbacks, including `onWebhookReceived`, may execute concurrently and may complete out
of delivery order. Use the delivery ID for idempotency and use an upstream sequence or version when
the provider's event order affects state.

Hook callbacks receive the durable hook context as their second argument, including
`idempotencyKey`, `hookId`, retry metadata, and transaction access.

## Security notes

- Use `allowedBaseUrls` in production to avoid SSRF.
- Request paths must be relative; absolute request URLs are rejected.
- Stored auth replaces caller-provided `Authorization` headers.
- Secrets and tokens are stored in the fragment database as JSON/plaintext for MVP.
- OAuth state is one-time use and expires after 10 minutes.
- Do not log secret payloads, authorization headers, refresh tokens, or token endpoint responses.
