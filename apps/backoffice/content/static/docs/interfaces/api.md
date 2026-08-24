# API reference

> Status: outline · Documentation type: reference

This page should describe the Backoffice HTTP surfaces, route ownership, authentication mode, scope
encoding, and proxy behavior. Keep task instructions in separate how-to guides.

## Planned reference sections

- Route families and mount points.
- Public, authenticated, webhook, and internal endpoints.
- Scope path encoding for system, organization, project, and user contexts.
- Fragment proxy request flow.
- OAuth callback routing.
- Request and response conventions.
- Error and authorization behavior.
- Development-only routes.

## Code references

- `apps/backoffice/app/routes.ts` — React Router route map.
- `apps/backoffice/app/routes/api/api.ts` — scoped API fragment proxy.
- `apps/backoffice/app/routes/api/automations-scoped.ts` — scoped automations proxy.
- `apps/backoffice/app/routes/api/mcp.ts` — MCP endpoint.
- `apps/backoffice/app/routes/api/github-webhooks.ts` — webhook ingress example.
- `apps/backoffice/app/fragno/scoped-public-fragment-routes.ts` — path constants and route policy.
- `apps/backoffice/app/fragno/scoped-public-fragment-proxy.ts` — forwarding implementation.
- `apps/backoffice/app/backoffice-runtime/scope-codec.ts` — scope serialization.
- `apps/backoffice/workers/api.do.ts` — API Durable Object host.
