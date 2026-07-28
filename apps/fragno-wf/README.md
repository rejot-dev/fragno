# fragno-wf

> **Status: broken and unsupported. Do not use or document this CLI.**

This private workspace application is out of sync with the current `@fragno-dev/workflows` HTTP API.

Known incompatibilities:

- `send-event` expects the old response shape instead of `{ accepted: true }`.
- `history` expects removed pagination and log fields and does not display step emissions.
- `logs` depends on workflow logs that are not exposed by the current history route.
- The current retry route and step-emission stream are not supported.

Before this application is exposed again, align every command with the current routes and cover the
full command tree with integration tests against a real Workflows fragment instance.
