---
name: upload-connection
description:
  Configure Upload storage providers and inspect Upload hooks. Use when storage configuration,
  provider selection, or Upload connection health is the task.
---

# Upload Connection

Use this skill for organisation-scoped Upload storage configuration and hook behavior.

# Upload configuration

Configuration fields:

- `provider`: provider to configure: `database`, `r2-binding`, or `r2`.
- `defaultProvider`: default provider to use after configuration.
- `r2`: R2 provider credentials/configuration payload. Secret.
- `r2Binding`: R2 binding provider configuration payload.

Setup notes:

- `database` is the simplest provider when external object storage is not required.
- Use `r2-binding` when storage is provided by Worker bindings.
- Use `r2` when explicit R2 credentials/config are needed.

# Upload events

Cataloged automation events:

- `source`: `upload`, `eventType`: `capability.configured` — fires after Upload is configured for an
  organisation for the first time.

Upload hook work is available under the `upload` hook scope.

# Upload tools

Prepared file lifecycle operations are documented by the `using-prepared-uploads` skill.

Use Backoffice connection tools for configuration and status, and hook tools for queued hook
inspection.
