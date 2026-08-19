# About integrations

> Status: outline · Documentation type: explanation

This document should explain how external services become scoped Backoffice capabilities and how
they participate in events, API calls, authentication, and codemode.

## Planned sections

- Connection catalog and capability discovery.
- Supported scopes and configuration ownership.
- Configuration state and `capability.configured` events.
- OAuth, webhook, token, and environment-backed integrations.
- Provider declarations and capability skill files.
- How integration operations appear in codemode.
- Current integrations: GitHub, Resend, Reson8, Telegram, and Upload.
- Failure modes, revocation, and reconfiguration.

## Code references

- `apps/backoffice/app/fragno/backoffice-capabilities/backoffice-capabilities.ts` — connection
  catalog.
- `apps/backoffice/content/static/skills/` — built-in integration skills.
- `apps/backoffice/app/routes/backoffice/automations/integrations.tsx` — scoped integration
  overview.
- `apps/backoffice/app/routes/backoffice/connections/` — integration-specific configuration and
  views.
- `apps/backoffice/app/routes/backoffice/integrations/scope.ts` — scope resolution.
- `apps/backoffice/app/routes/api/` — integration API endpoints and webhooks.
- `apps/backoffice/app/fragno/github.ts` — GitHub integration composition.
- `apps/backoffice/app/fragno/resend.ts` — Resend integration composition.
- `apps/backoffice/app/fragno/reson8.ts` — Reson8 integration composition.
- `apps/backoffice/app/fragno/telegram.ts` — Telegram integration composition.
- `apps/backoffice/app/fragno/upload.ts` — Upload integration composition.
