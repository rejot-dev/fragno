# About system interfaces

> Status: outline · Documentation type: explanation

This section should explain the boundaries through which browsers, integrations, automations, and
external tool servers interact with the Backoffice.

## Planned sections

- Public, authenticated, and internal API boundaries.
- Scope encoding and scoped fragment proxies.
- Integrations as configured capabilities that emit events and expose operations.
- MCP servers as dynamically discovered tool providers.
- Authentication, OAuth callbacks, credentials, and authorization.
- How interfaces become codemode providers under `/providers` and `/sources`.

## Related documents

- [API reference](api.md)
- [Integrations](integrations.md)
- [MCP](mcp.md)
- [Events](../events/README.md)

## Code references

- `apps/backoffice/app/routes/api/` — externally reachable route modules.
- `apps/backoffice/app/fragno/scoped-public-fragment-routes.ts` — public and internal path
  conventions.
- `apps/backoffice/app/fragno/scoped-public-fragment-proxy.ts` — scoped request forwarding.
- `apps/backoffice/app/backoffice-runtime/object-registry.ts` — scope-owned runtime objects.
- `apps/backoffice/app/fragno/backoffice-capabilities/` — provider and capability catalog.
- `apps/backoffice/app/fragno/runtime-tools/` — runtime tool exposure.
