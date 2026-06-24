import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createApiWebhooksCapabilityFiles = () =>
  skillFiles({
    name: "api-webhooks",
    title: "API Webhooks",
    description:
      "Configure inbound webhooks received by Backoffice API endpoints. Use when the user wants to receive provider webhooks, asks for a webhook/callback endpoint URL, gives a webhook secret or sample payload, configures webhook authentication/signatures, or wires webhook.received events into automations.",
    overview:
      "Use this skill for scope-aware inbound HTTP webhook endpoints, provider delivery IDs, webhook authentication, public webhook URLs, and webhook-triggered automations.",
    configuration: `# API webhook configuration

Configuration fields:

Initialize the API capability first; webhook endpoints share the same API capability storage and public base URL.

Typical setup flow:

1. Initialize the shared API capability and create a draft endpoint. Assume the user needs a webhook URL before auth, payload, or header details are known. Deduce a good stable lowercase \`endpointId\` from the user's request; this is usually the name of the service you are configuring webhooks for:

\`\`\`js
const apiCapability = await connections.configure({ id: "api", payload: {} });
const draft = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "draft",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

return { publicBaseUrl: apiCapability.config?.publicBaseUrl, webhookUrl: draft.publicUrl };
\`\`\`

Draft endpoints reserve a stable URL and reject deliveries with "not configured yet" until you update them to \`status: "active"\`.

2. Collect the remaining inputs before activating the draft endpoint:
   - webhook auth type: \`none\`, \`bearer\`, \`apiKey\`, \`basic\`, or \`hmac\`. Typical case is HMAC.
   - if auth is \`hmac\`: algorithm, signature header/query name, signature encoding, optional prefix, and whether the provider signs the raw body or a timestamped body;
   - example JSON payload;
   - relevant delivery/signature headers.
3. If any auth, signature, payload, header, or delivery identity detail is unknown, keep the endpoint in \`draft\` and ask the user for the missing details. Do not activate the endpoint yet.
4. Choose \`deliveryIdentity\` from the example payload or headers. Prefer provider delivery ids such as \`webhookId\`, \`event.id\`, \`id\`, or a provider delivery-id header.
5. Update the draft endpoint with the correct auth configuration, delivery identity, and \`status: "active"\`. Return the exact \`webhook.publicUrl\` from the tool result:

\`\`\`js
const webhook = await api.updateWebhookEndpoint({
  endpointId: "example-provider",
  status: "active",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: {
    type: "hmac",
    secret: "whs_secret_123",
    algorithm: "sha256",
    signature: {
      location: "header",
      name: "x-provider-signature",
      encoding: "hex",
    },
    signedPayload: { type: "rawBody" },
  },
});

return webhook.publicUrl;
\`\`\`

6. Tell the user you are standing by to check for deliveries. Once the provider sends a test delivery, verify recent API durable hooks:

\`\`\`js
await hooks.list({ fragment: "api", pageSize: 10 });
\`\`\`

Notes:
- Public receive URLs look like \`/api/http/:scope/webhooks/endpoints/:endpointId/events\`.
- Return the exact \`webhook.publicUrl\` after creating or updating an endpoint; do not manually assemble the final URL unless you are only explaining the URL shape before creation.


Rules:

- ALWAYS start by immediately setting up a draft endpoint with a good endpointId AND informing the user of the FULL receiving webhook URL. ALWAYS DO THIS.
- Do not talk about setting up the API connection (i.e. \`connections.get({ id: 'api' })\`) unless something is wrong.
- Do NOT mention the public base URL. This could confuse the user. Only mention the fully qualified url including the filled in endpointId and orgId. 
- Do not call \`connections.setup({ id: "api-webhooks" })\`; webhook endpoints use the shared \`api\` capability.
- Do not guess webhook auth from the word "secret" or "key". If the user says "webhook secret", "signing secret", or gives a secret-shaped webhook key, treat it as likely \`hmac\` and ask for the signature header/encoding/payload details if missing. Use \`bearer\` only when the provider explicitly sends an \`Authorization: Bearer ...\` header.
- Do not guess the delivery identity when the provider payload/header shape is unknown. 
- ALWAYS ask the user for an example webhook payload and relevant headers, then choose a stable id that is unique per provider delivery.
- If auth scheme, signature header, signature encoding, signed payload, or delivery identity is unknown, ask for the missing information before activating the endpoint. Create a draft endpoint first if the user needs the URL.
- DO NOT GUESS ANYTHING but the endpointId. Ask for all other details before activating the endpoint.

HMAC decision guide:

- \`algorithm\`: ask whether the provider uses \`sha1\`, \`sha256\`, or \`sha512\`.
- \`signature.location\`: ask whether the signature is in a \`header\` or \`query\` parameter.
- \`signature.name\`: ask for the exact header or query parameter name.
- \`signature.encoding\`: ask whether the signature value is \`hex\`, \`base64\`, or \`base64url\`.
- \`signature.prefix\`: include this only when the provider prefixes the signature value, for example \`sha256=\` or \`v1=\`.
- \`signedPayload\`: use \`rawBody\` only when the provider signs the raw request body. Use \`timestampBody\` when the provider signs a timestamp joined with the body.

Basic setup example:

\`\`\`js
const webhook = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "active",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

return webhook.publicUrl;
\`\`\`

HMAC setup example:

\`\`\`js
const webhook = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "active",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: {
    type: "hmac",
    secret: "whs_secret_123",
    algorithm: "sha256",
    signature: {
      location: "header",
      name: "x-provider-signature",
      encoding: "hex",
    },
    signedPayload: { type: "rawBody" },
  },
});

return webhook.publicUrl;
\`\`\`
`,
    events: `# API webhook events

Cataloged automation events:

- \`source\`: \`api\`, \`eventType\`: \`webhook.received\` — fires after a configured webhook endpoint accepts and authenticates a delivery.

Webhook payloads include:

- \`endpointId\`
- \`deliveryId\`
- \`hookId\`
- \`receivedAt\`
- redacted \`headers\`
- redacted \`query\`
- parsed JSON \`body\`
- \`contentType\`

Use \`hookId\` or the automation event id for idempotency. Duplicate provider deliveries with the same endpoint and delivery id produce the same hook id.
`,
    tools: `# API webhook tools

API webhook tools can:

- list configured webhook endpoints;
- inspect a webhook endpoint;
- create or replace a webhook endpoint;
- update a webhook endpoint;
- delete a webhook endpoint.

Use codemode first. The \`api\` provider methods are \`listWebhookEndpoints\`, \`getWebhookEndpoint\`, \`createWebhookEndpoint\`, \`updateWebhookEndpoint\`, and \`deleteWebhookEndpoint\`.

Examples:

\`\`\`js
await api.listWebhookEndpoints();

const draft = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "draft",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

const webhook = await api.updateWebhookEndpoint({
  endpointId: draft.id,
  status: "active",
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

return webhook.publicUrl;
\`\`\`
`,
  });
