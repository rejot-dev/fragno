import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createApiCapabilityFiles = () =>
  skillFiles({
    name: "api-connection",
    title: "API Connection",
    description:
      "Configure and use Backoffice API connections. Use when creating outbound HTTP API integrations, configuring OAuth or bearer authentication, starting API OAuth flows, checking auth status, or executing authenticated API requests from automations.",
    overview:
      "Use this skill for scope-aware outbound HTTP API connections, OAuth PKCE authentication, bearer tokens, client credentials, and API requests through Backoffice runtimes.",
    configuration: `# API configuration

Configuration fields:

Initialize the API capability to store the scope id and prepare the public OAuth callback route.

Setup notes:

- Initialize the API capability before creating API connections:

\`\`\`js
await connections.configure({ id: "api", payload: {} });
\`\`\`

- Create each external API connection with a stable lowercase slug and a base URL.
- Use \`api.*\` methods for API connections.
- Register the public OAuth callback route \`/api/http/:orgId/oauth/callback\` for organisation-scoped OAuth connections.
- Use relative request paths, for example \`/v1/customers\`. If the user gives \`https://example.com/v1/customers\` and the connection base URL is \`https://example.com\`, call \`api.request\` with \`path: "/v1/customers"\`.
- Let stored connection auth replace caller-provided \`Authorization\` headers.
- If the user supplies a client secret in the session and asks you to configure the connection, pass it to \`api.createConnection\` and keep the final response secret-free.

Rules:
- When configuring a new OAuth connection, ALWAYS immediately start OAuth and give the user the returned \`authorizationUrl\` in a clickable way.
- When the user says _anything_ after you've presented them with the link, ALWAYS check status of the connection and report back to the user.

Typical OAuth setup flow:

1. Initialize the API capability:

\`\`\`js
await connections.configure({ id: "api", payload: {} });
\`\`\`

2. Create the API connection with the requested auth configuration.
3. For OAuth connections, immediately start OAuth after creating the connection and give the returned authorization URL to the user:

\`\`\`js
const connection = await api.createConnection({
  slug: "example-api",
  name: "Example API",
  baseUrl: "https://api.example.com",
  auth: {
    type: "oauth",
    authorizationEndpoint: "https://api.example.com/oauth/authorize",
    tokenEndpoint: "https://api.example.com/oauth/token",
    clientId: "example-client",
    clientSecret: "example-client-secret",
    scopes: ["profile", "email", "read"],
    tokenEndpointAuthMethod: "client_secret_post",
  },
});

const oauth = await api.startOAuth({ slug: connection.slug });
return { connection, authorizationUrl: oauth.authorizationUrl };
\`\`\`

4. When the user responds after opening the OAuth URL, always check authentication status:

\`\`\`js
const status = await api.getAuthStatus({ slug: "example-api" });
return status;
\`\`\`

5. If authentication is successful, tell the user the connection is authenticated and ask whether they want to try an API call.
6. When the user wants to test an API call, call \`api.request\` with a relative path and include \`Accept: "application/json"\` for JSON APIs.

Bearer setup example:

\`\`\`js
await api.createConnection({
  slug: "stripe",
  name: "Stripe",
  baseUrl: "https://api.stripe.com",
  auth: { type: "bearer", token: process.env.STRIPE_TOKEN },
});
\`\`\`

OAuth setup example for a confidential server-side client:

\`\`\`js
await api.createConnection({
  slug: "example-api",
  name: "Example API",
  baseUrl: "https://api.example.com",
  auth: {
    type: "oauth",
    authorizationEndpoint: "https://api.example.com/oauth/authorize",
    tokenEndpoint: "https://api.example.com/oauth/token",
    clientId: "example-client",
    clientSecret: "example-client-secret",
    scopes: ["profile", "email", "read"],
    tokenEndpointAuthMethod: "client_secret_post",
  },
});

const auth = await api.startOAuth({ slug: "example-api" });
return auth.authorizationUrl;
\`\`\`

OAuth connections run server-side in Backoffice. Use the token endpoint auth method configured for the provider's OAuth app registration. Confidential clients usually use \`tokenEndpointAuthMethod: "client_secret_post"\` or \`"client_secret_basic"\` with \`clientSecret\`. Public PKCE client registrations use \`tokenEndpointAuthMethod: "none"\` with client id and scopes.

OAuth restart and troubleshooting notes:

- To restart OAuth with unchanged settings, call \`api.startOAuth({ slug })\` and give the user the newest \`authorizationUrl\`.
- To restart OAuth after auth settings were removed or the connection shows \`authMode: "none"\`, recreate the connection with the full OAuth config and then call \`api.startOAuth({ slug })\`.
- After changing \`tokenEndpointAuthMethod\`, client secret, scopes, endpoints, or redirect route, start OAuth again and tell the user to use the newest OAuth tab. Old authorization URLs contain old state, redirect URI, and PKCE challenge data.
- If the callback reports \`The client cannot authenticate with methods: [...]\`, the authorization step succeeded and the token exchange failed. Align the configured \`tokenEndpointAuthMethod\` with the provider-side OAuth app registration. Use \`"client_secret_post"\` or \`"client_secret_basic"\` for confidential client registrations, and use \`"none"\` for public PKCE client registrations.
- If a previously failing client starts working after provider-side changes, recreate or update the connection and generate a fresh authorization URL before retesting.
`,
    events: `# API events

Cataloged automation events:

- \`source\`: \`api\`, \`eventType\`: \`connection.changed\` — fires when an API connection is created or its configuration changes.
- \`source\`: \`api\`, \`eventType\`: \`connection.deleted\` — fires when an API connection is deleted.
- \`source\`: \`api\`, \`eventType\`: \`connection.available\` — fires when auth becomes usable after bearer setup, OAuth callback, or client-credentials token acquisition.

Hook payloads include \`connectionId\` and a connection snapshot with \`slug\`, \`name\`, \`baseUrl\`, \`authMode\`, and \`status\`.
`,
    tools: `# API tools

API tools can:

- list configured API connections;
- create and delete outbound HTTP API connections;
- inspect auth status;
- store bearer tokens;
- start OAuth login;
- delete stored auth;
- execute authenticated HTTP requests through a configured connection.

Use codemode first. The \`api\` provider methods are \`listConnections\`, \`createConnection\`, \`deleteConnection\`, \`getAuthStatus\`, \`setToken\`, \`startOAuth\`, \`deleteAuth\`, and \`request\`.

Examples:

\`\`\`js
await api.listConnections();
await api.getAuthStatus({ slug: "example-api" });
await api.request({
  slug: "example-api",
  method: "GET",
  path: "/v1/resources",
  headers: { Accept: "application/json" },
  timeoutMs: 30_000,
});
\`\`\`

Bash runtime commands include \`api.connections.list\`, \`api.connections.create\`, \`api.connections.delete\`, \`api.auth.status\`, \`api.auth.token\`, \`api.oauth.start\`, \`api.auth.delete\`, and \`api.request\`.

For JSON request bodies, use \`api.request --json '{"key":"value"}'\`. For text bodies, use \`--body\`.

Request debugging notes:

- Always check \`api.getAuthStatus({ slug })\` before debugging an API request. \`authenticated: true\` means OAuth credentials are stored; returned HTTP \`404\`, \`405\`, or \`500\` statuses are upstream API responses.
- Treat upstream 4xx and 5xx responses from \`api.request\` as response data with \`status\`, \`statusText\`, \`headers\`, and \`body\`.
- If a user provides a full URL, convert it to a relative path for the configured connection base URL.
- For endpoints like token introspection, inspect the upstream \`Allow\` and \`WWW-Authenticate\` headers. A \`405\` with \`Allow: OPTIONS, POST\` means retry with POST; a \`401 invalid_client\` means that endpoint requires its own client authentication and often a form body such as a \`token\` parameter.
- If you see a runtime validation error about missing \`statusText\`, rebuild or restart the API fragment/runtime; current API responses include \`statusText\`.
`,
  });
