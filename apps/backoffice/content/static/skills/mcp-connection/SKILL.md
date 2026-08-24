---
name: mcp-connection
description:
  Configure and use Backoffice MCP servers. Use when registering remote MCP endpoints,
  authenticating MCP servers with OAuth or bearer tokens, listing MCP tools, or calling MCP tools
  from automations.
---

# MCP Connection

Use this skill for organization-scoped MCP server registration, OAuth or bearer-token
authentication, tool discovery, and MCP tool calls from Backoffice runtimes.

# MCP configuration

The MCP capability is available automatically for the current scope.

- Register each remote MCP server with a stable lowercase slug, a display name, the streamable HTTP
  endpoint URL, and an auth mode.
- For OAuth servers, create the server first with `auth: { type: "oauth" }`, then start OAuth and
  send the returned `authorizationUrl` to the user.
- For bearer-token servers, create the server with `auth: { type: "bearer", token }` or set the
  token after creation.

OAuth setup example:

```js
const serverId = "cloudflare-mcp";

await mcp.createServer({
  slug: serverId,
  name: "Cloudflare MCP",
  endpointUrl: "https://mcp.cloudflare.com/mcp",
  auth: { type: "oauth" },
});

const auth = await mcp.startOAuth({ slug: serverId });
return auth.authorizationUrl;
```

After the user completes OAuth, refresh the server tools with
`mcp.refreshServer({ slug: serverId })`.

# MCP events

Cataloged automation events:

- `source`: `mcp`, `eventType`: `server.configuration.changed` — fires after a server refresh when
  the advertised tools differ from the previous cache.
- `source`: `mcp`, `eventType`: `server.configuration.deleted` — fires after an MCP server
  configuration is deleted.

Treat MCP as a tool-backed capability: automations register servers, refresh advertised tool caches,
and call those tools when an external MCP service is needed.

# MCP tools

MCP tools can:

- list configured MCP servers;
- register and delete remote streamable HTTP MCP servers;
- start OAuth login for a server;
- store bearer tokens;
- refresh the cached tools advertised by a configured server;
- call tools exposed by a configured server.

Use the declared `mcp` provider methods: `listServers`, `createServer`, `deleteServer`,
`refreshServer`, `startOAuth`, `setToken`, and `callTool`.

Examples:

```js
await mcp.listServers();
await mcp.refreshServer({ slug: "cloudflare-mcp" });
await mcp.callTool({
  slug: "cloudflare-mcp",
  name: "docs",
  arguments: { query: "Durable Objects alarms" },
});
```
