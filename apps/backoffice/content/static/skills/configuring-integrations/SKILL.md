---
name: configuring-integrations
description: >
  Connect, set up, verify, reconfigure, or disconnect a service. Walks a source ladder: native
  Backoffice services such as Telegram, Resend, Reson8, and Upload first, then Open Connector OAuth
  providers, then remote MCP servers, then direct HTTP API connections. Load with the service's
  provider-specific skill.
---

# Configuring Integrations

`integrations.*` is one facade over four connection sources. Every connection has a scoped address
`namespace#local-id`; copy addresses from discovery and listing verbatim. Read
`/static/codemode/providers/integrations.d.ts` before calling it.

| Rung | Source          | Address                                    | Owning scope       |
| ---- | --------------- | ------------------------------------------ | ------------------ |
| 1    | Backoffice      | `backoffice#<service>`, or `connections.*` | organization       |
| 2    | Open Connector  | `connector#n_…`, `connector#a_…` (opaque)  | user               |
| 3    | MCP server      | `mcp#<slug>`, slug chosen by you           | org, user, project |
| 4    | Direct HTTP API | `api#<slug>`, slug chosen by you           | org, user, project |

## 1. Discover

```js
async () => ({
  scope: await context.getCurrentScope(),
  services: await integrations.discover(),
  page: await integrations.list({ cursor: null }),
  nativeCatalog: await connections.list(),
});
```

Discovery is scoped. Open Connector services appear only in user scope, so for a personal OAuth
account requested from an organization or project, also discover through
`context.user(userId).integrations`. Page `list` with the returned cursor until it is null.

**Complete when** you know every available service matching the request, its setup targets, and any
configured connection for it. A matching configured connection is reused: take its `connectionId`
straight to step 3.

## 2. Choose the rung

Take the highest rung that offers the requested service:

1. **Backoffice**: a service whose setup target is `backoffice#…`. A native service that appears
   only in `nativeCatalog`, such as Telegram, Resend, or Upload, is configured through
   `connections.*`: follow `/static/skills/configuring-integrations/CONNECTIONS.md` in place of
   steps 3 and 4.
2. **Open Connector**: a service whose `id` names the provider, such as `gmail`, with
   `connector#n_…` targets. Use the target unchanged; it preassigns the connection name. Several
   targets mean several provider configurations: use the user's choice.
3. **MCP server**: the `mcp` service, chosen when the provider publishes a streamable HTTP MCP
   endpoint or the user supplies one. Choose a slug of lowercase letters, digits, and `-`, such as
   `mcp#cloudflare`. Take the endpoint URL from provider documentation.
4. **Direct HTTP API**: the `api` service, chosen when no higher rung offers the service or the user
   asks for a direct API connection. Choose a lowercase slug such as `stripe` (letters, digits, `.`,
   `_`, `-`, starting with a letter or digit) and address it as `api#stripe`. Take the base URL and
   auth method from provider documentation; a service name alone establishes neither.

An `unavailable` service names its reason, usually the owning scope; use that scope when the user
owns it. Read the service's provider-specific skill, such as
`/static/skills/telegram-integration/SKILL.md`, for its fields, events, and tools.

**Complete when** exactly one `connectionId`, or one `connections.*` catalog ID, is selected from
the highest rung that offers the service.

## 3. Run the setup loop

Check, act on the status, and check again until the loop reaches `ready` or a stop status:

```js
async () => await integrations.setup({ kind: "check", connectionId });
```

- **`needs-input`**: `inputSchema` is the complete set of inputs and `secretFields` names the
  secrets. Submit the matching object directly as
  `integrations.setup({ kind: "input", connectionId, input })`.
- **`needs-authorization`**: give the user `authorizationUrl` as a link. When the user replies,
  check again; only the next check confirms consent.
- **`pending`**: check again later.
- **`ready`**: continue to step 4. Ready means stored, not proven.
- **`blocked`** or **`expired`**: report `reason`. When it names `integrations.reconfigure`, offer
  the replacement in "Change or remove"; otherwise stop. A lower rung creates a different
  connection, so move down only on the user's choice.

For `api#` addresses, the input's `type` selects the auth mode, and an OAuth submission starts
consent at once. The first check's `instructions` state the scope's exact OAuth callback URL. Give
the user that URL to register in the provider's OAuth app in the same message that asks them to
create the app, before they send credentials; consent fails with a redirect URI error until the app
lists it.

For `mcp#` addresses, `type` likewise selects the auth mode and an OAuth submission starts consent.
Servers with dynamic client registration need no client; otherwise include `clientId` and
`clientSecret`. A `blocked` result naming dynamic client registration means the server needs a
pre-registered client: have the user create an OAuth app with the stated callback URL, then
reconfigure with its client.

Collect missing values through a durable form unless the request already supplies all of them. Read
`/static/skills/workflows/SKILL.md` and `/static/skills/generating-backoffice-uis/SKILL.md`, then
define an inline workflow whose completed `step.do` returns a `$ui` form with one control per
`inputSchema` field, masked for `secretFields`, and whose `step.waitForEvent` collects the
submission. Continue the loop and verification in later `step.do` calls. Keep secrets out of labels,
summaries, and final output.

Setup keeps stored credentials: a ready connection ignores new input. Replacing them is
reconfiguration.

**Complete when** a check returns `ready`.

## 4. Verify

`integrations.verify({ connectionId })` runs the source's read-only live check. Backoffice, Open
Connector, and MCP return timestamped `passed` or `failed` checks; MCP's lists the server's tools.
Direct API connections return no checks: prove access with one read-only `request`, such as the
provider's profile or account endpoint. `integrations.get` never contacts the provider.

**Complete when** a `passed` check or an `ok: true` read-only request proves access. Otherwise
report the check message or error and the connection's `nextSteps`.

## Change or remove

Both operations replace or delete live credentials, so run them on the user's instruction.

- **Reconfigure**: `integrations.reconfigure({ kind: "check", connectionId })` returns the
  replacement `inputSchema`; submit with `kind: "input"`, collecting values as in step 3. A
  submission replaces the stored configuration and credentials, then returns setup progress: rerun
  the setup loop and step 4. For an `api#` or `mcp#` OAuth connection whose provider revoked access,
  submit `{ reauthorize: true }` to consent again with the stored client; changing scopes,
  endpoints, or the client is a full replacement.
- **Disconnect**: `integrations.disconnect({ connectionId, confirm: connectionId })` removes the
  configuration and credentials. `not-configured` means nothing was stored. The address stays valid
  for a later setup.

Open Connector supports neither; to consent again, set up a fresh connection name.

**Complete when** reconfiguration reaches `ready` and step 4 proves access again, or disconnect
returns `disconnected` or `not-configured`.

## Use the connection

`integrations.actions({ connectionId })` returns each action's authoritative input and output
schemas; build input from the selected `inputSchema`.

Obtain the user's instruction before any action that writes or sends. `integrations.execute` runs
once; an output failure arrives after the action has run, so report it rather than repeating the
call.

### Direct API connections

Direct API connections have two actions. `connection.describe` takes `{}` and returns the stored
base URL, auth mode, and auth state; call it first, and turn any full URL from the user into a path
relative to that base URL. `request` takes `{ method, path, query, headers, body }` with `body.type`
of `empty`, `json`, or `text`; upstream HTTP errors return as `ok: false` results with their status,
headers, and body.

- Send the headers the provider requires, such as `Accept: application/json`. GitHub rejects
  requests without a `User-Agent`.
- `401` or `403` on a ready connection means the provider rejected the credentials or their scope:
  reauthorize an OAuth connection, or reconfigure with new credentials.
- A callback or token error such as `invalid_client` or "client cannot authenticate with methods"
  means `tokenEndpointAuthMethod` differs from the provider app's registration. Confidential apps
  use `client_secret_post` or `client_secret_basic`; public PKCE apps use `none`. Reconfigure to
  match.
- A `405` lists allowed methods in `Allow`; a `401` with `WWW-Authenticate` names the scheme the
  endpoint expects.
- Responses decode as JSON or text, so binary downloads arrive altered.

### MCP servers

Each server tool is an action with the tool's own input schema. Results are
`{ isError, content, structuredContent }`: `isError: true` is the tool's own answer, explained in
`content`, so report it rather than retrying. Tools appear once the server's tools are discovered,
shortly after setup is ready; if `actions` is empty, run `integrations.verify`. Tools whose schemas
cannot be validated are not offered as actions, and `integrations.get` names them in `nextSteps`.

Inbound webhooks are endpoints, not connections: configure them with `api.webhooks.*` following
`/static/skills/api-webhooks/SKILL.md`.

## Authority and terminal

Discovery, listing, inspection, and action contracts require `integrations.read`; setup,
reconfigure, disconnect, and verification require `integrations.manage`; execution requires
`integrations.execute`. Each source also enforces its native permissions. Report a permission
failure as it stands, in the current scope and source.

Terminal commands share the names, e.g.
`integrations.setup --connection-id 'api#stripe' --input-json '{...}'` and
`integrations.disconnect --connection-id 'api#stripe' --confirm 'api#stripe'`. Quote addresses,
since `#` starts a shell comment. Read `/static/terminal/terminal-spec.json` for options.
