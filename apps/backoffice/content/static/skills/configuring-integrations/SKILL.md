---
name: configuring-integrations
description: >
  Integrations: any service the user names, whether an MCP server, an HTTP API, an inbound webhook,
  an Open Connector account, or Telegram, Resend, or GitHub. Use to connect one, change its auth,
  credentials, or endpoint, verify, disconnect, call it, generate a typed client for it, or react to
  its connection changes.
---

# Configuring Integrations

`integrations.*` is one facade over every connection source. Every connection has a scoped address
`namespace#local-id`; copy addresses from discovery and listing verbatim. Read
`/static/codemode/providers/integrations.d.ts` before calling it.

| Rung | Source          | Address                          | Owning scope       |
| ---- | --------------- | -------------------------------- | ------------------ |
| 1    | Backoffice      | see the native list below        | see below          |
| 2    | Open Connector  | `connector#n_…` (opaque)         | user               |
| 3    | MCP server      | `mcp#<slug>`, slug chosen by you | org, user, project |
| 4    | Direct HTTP API | `api#<slug>`, slug chosen by you | org, user, project |

These are all the native Backoffice integrations:

| Service  | Address               | Owning scope                                       | Provides                              |
| -------- | --------------------- | -------------------------------------------------- | ------------------------------------- |
| Telegram | `backoffice#telegram` | every scope, each with its own bot                 | bot messages, `message.received`      |
| Resend   | `backoffice#resend`   | organization; system is the platform email account | email threads and replies             |
| GitHub   | `github#owner/repo`   | organization, one connection per repository        | repository API through the GitHub App |

Receiving a provider's webhooks is not a rung but its own source: `webhook#<endpointId>`, owned by
an organization, user, or project. It needs no outbound connection; when a provider is used in both
directions, such as Slack, it has an `api#` and a `webhook#` connection. Follow
`/static/skills/api-webhooks/SKILL.md` for its contract, events, and routes.

## 1. Discover

```js
async () => ({
  scope: await context.getCurrentScope(),
  services: await integrations.discover(),
  page: await integrations.list({ cursor: null }),
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

1. **Backoffice**: a service from the native list. Fixed addresses such as `backoffice#telegram`
   appear as setup targets. For GitHub, address the repository as `github#owner/repo`, with GitHub's
   casing since addresses are case-sensitive; when the GitHub App cannot reach it yet, submitting
   `{ link: true }` returns the GitHub link that grants access.
2. **Open Connector**: a service whose `id` names the provider, such as `gmail`, with
   `connector#n_…` targets. Use the target unchanged; it preassigns the connection name. Several
   targets mean several provider configurations: use the user's choice. Its gateway credentials are
   server configuration: when setup reports Connector as unconfigured, report that rather than
   asking the user for keys.
3. **MCP server**: the `mcp` service, chosen when the provider publishes a streamable HTTP MCP
   endpoint or the user supplies one. Choose a slug of lowercase letters, digits, and `-`, such as
   `mcp#cloudflare`. Take the endpoint URL from provider documentation.
4. **Direct HTTP API**: the `api` service, chosen when no higher rung offers the service or the user
   asks for a direct API connection. Choose a lowercase slug such as `stripe` (letters, digits, `.`,
   `_`, `-`, starting with a letter or digit) and address it as `api#stripe`. Take the base URL and
   auth method from provider documentation; a service name alone establishes neither.

An `unavailable` service names its reason, usually the owning scope; use that scope when the user
owns it. Each service's setup instructions, action schemas, and event catalog entries describe its
fields, actions, and events.

**Complete when** exactly one `connectionId` is selected from the highest rung that offers the
service.

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

## 5. Generate the client

Generate a client for the connection at `/workspace/integrations/<namespace>/<local-id>.js`: the
address with `#` as a folder separator, such as `/workspace/integrations/mcp/cloudflare.js` for
`mcp#cloudflare`. Nothing generates or updates it automatically, so a client may be missing or
outdated until this step runs.

```js
async () =>
  await integrations.generateClient({
    connectionId,
    out: "/workspace/integrations/mcp/cloudflare.js",
  });
```

Regenerate it whenever the connection's actions can change: after reconfiguration, and for an MCP
server whenever `integrations.verify` lists different tools. MCP actions appear only after tool
discovery, so verify before generating.

**Complete when** the client exists and its returned `exports` cover every action from
`integrations.actions`.

## Change or remove

Both operations replace or delete live credentials, so run them on the user's instruction.

- **Reconfigure**: `integrations.reconfigure({ kind: "check", connectionId })` returns the
  replacement `inputSchema`. Start the input from the `settings` that `integrations.get` returns,
  the stored values that are not secret, and change only what the user asked; collect secrets and
  any field `settings` omits as in step 3, then submit with `kind: "input"`. A submission replaces
  the stored configuration and credentials, then returns setup progress: rerun the setup loop, step
  4, and step 5. For an `api#` or `mcp#` OAuth connection whose provider revoked access, submit
  `{ reauthorize: true }` to consent again with the stored client; changing scopes, endpoints, or
  the client is a full replacement.
- **Disconnect**: `integrations.disconnect({ connectionId, confirm: connectionId })` removes the
  configuration and credentials. `not-configured` means nothing was stored. The address stays valid
  for a later setup. Then delete its client with `state.rm({ path })`.

Open Connector supports neither; to consent again, set up a fresh connection name. GitHub does not
support reconfigure, since repository access is changed in the GitHub App's installation settings;
its disconnect unlinks the repository from this organization.

**Complete when** reconfiguration reaches `ready`, step 4 proves access again, and step 5
regenerated the client; or disconnect returns `disconnected` or `not-configured` and the client file
is gone.

## React to connection changes

Every source reports connection state as automation events with `source: "integrations"`:

- `connection.ready`: configuration and authorization are stored.
- `connection.unavailable`: the connection exists but cannot be used, for example while consent is
  pending, after credentials were cleared, or while a GitHub installation is suspended.
- `connection.disconnected`: the connection was removed.

They fire for changes made anywhere, including native pages, OAuth callbacks, and provider webhooks,
and can repeat. Route one connection with
`{ path: "$.subject.connectionId", op: "eq", value: connectionId }`, or one source with
`$.subject.service`. An OAuth access token without a refresh token fires `connection.unavailable`
when it expires.

Open Connector learns about consent only when setup is checked, so its `connection.ready` follows
the next check rather than the browser consent, and revocation is never reported.

## Use the connection

`integrations.actions({ connectionId })` returns each action's authoritative input and output
schemas; build input from the selected `inputSchema`.

Binary inputs are byte arrays of real file content: read the file with
`state.readFileBytes({ path })` and pass `Array.from(bytes)`. Action inputs list every field; pass
`null` for a default.

Obtain the user's instruction before any action that writes or sends. `integrations.execute` runs
once; an output failure arrives after the action has run, so report it rather than repeating the
call.

### Typed clients

A connection's client (step 5) exports one async function per action, typed with JSDoc from the
action contracts; `exports` maps each function `name` to its `actionId`. Every function calls
`integrations.execute`, with the same validation and permissions. Import the client by its absolute
path; saved modules may also import it relatively, and `js.check` checks callers against its types.

Put your own helpers in a separate module that imports the client: regeneration replaces the client,
and generation refuses to replace any file it did not generate.

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
shortly after setup is ready; if `actions` is empty, run `integrations.verify`. A tool whose schemas
cannot be validated is an action with `validation.kind: "unchecked"` and a `reason`;
`integrations.execute` runs it only with `unchecked: true`, skipping validation so the server alone
rejects bad input. Its generated client function passes the flag itself.

An action's output schema types a successful result's `structuredContent` with the tool's own output
schema, so a generated client narrows it after checking `isError`.

When an `mcp#` OAuth connection loses its authorization, start consent again without waiting to be
asked (submit `{ start: true }` when the setup check asks for it, otherwise `{ reauthorize: true }`
through `integrations.reconfigure`) and give the user the returned `authorizationUrl` as a link.

### Installed apps

An `app#<slug>` connection, e.g. `app#bookkeeping`, exists once an organization owner installs an
app that declares actions; there is nothing to set up. Its actions run on the app's own server, as
the signed-in user or, in automations, as the installation. When `integrations.get` reports a
missing installation, an unlinked account, or changed actions awaiting approval, pass its
`nextSteps` to an organization owner: installing and approving are theirs (`apps.install`,
`apps.installations.approveActions`).

## Authority and terminal

Discovery, listing, inspection, and action contracts require `integrations.read`; setup,
reconfigure, disconnect, and verification require `integrations.manage`; execution requires
`integrations.execute`. Each source's own store also checks `connections.read` for reading its
configuration and `connections.manage` for changing it. Report a permission failure as it stands, in
the current scope and source.

Terminal commands share the names, e.g.
`integrations.setup --connection-id 'api#stripe' --input-json '{...}'` and
`integrations.disconnect --connection-id 'api#stripe' --confirm 'api#stripe'`. Quote addresses,
since `#` starts a shell comment. Read `/static/terminal/terminal-spec.json` for options.
