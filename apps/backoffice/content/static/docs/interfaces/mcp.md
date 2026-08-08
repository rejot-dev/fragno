# About MCP

> Status: outline · Documentation type: explanation

This document should explain how the Backoffice connects to remote Model Context Protocol servers,
discovers tools, handles authentication, and exposes those tools to codemode.

## Planned sections

- MCP server configuration and scope ownership.
- Streamable HTTP endpoints.
- OAuth, bearer-token, and unauthenticated modes.
- Tool discovery, caching, refresh, and input schemas.
- Required scopes and authorization metadata.
- Tool naming and codemode exposure.
- Server configuration change hooks.
- Errors, expired credentials, and unavailable tools.

## Code references

- `apps/backoffice/app/fragno/mcp.ts` — MCP fragment composition and mount route.
- `apps/backoffice/app/routes/api/mcp.ts` — HTTP route.
- `apps/backoffice/workers/mcp.do.ts` — MCP Durable Object host.
- `apps/backoffice/app/routes/backoffice/automations/mcp.tsx` — MCP configuration and tool catalog
  UI.
- `apps/backoffice/app/routes/backoffice/connections/mcp/data.ts` — scoped MCP data access.
- `apps/backoffice/app/fragno/codemode/mcp-codemode-tools.ts` — codemode tool generation.
- `apps/backoffice/app/fragno/codemode/mcp-codemode-tools.test.ts` — tool exposure behavior.
- `packages/mcp-fragment/` — underlying MCP Fragment implementation.
