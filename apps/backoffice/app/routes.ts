import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  // Cadence — the automations studio, mounted at the root.
  layout("layouts/cadence-layout.tsx", [
    index("routes/cadence/exec.tsx"),
    route("workflows", "routes/cadence/workflows.tsx"),
    route("ops", "routes/cadence/ops.tsx"),
    route("settings", "routes/cadence/settings.tsx"),
  ]),

  route("backoffice/login", "routes/backoffice/login.tsx"),
  route("backoffice/sign-up", "routes/backoffice/sign-up.tsx"),
  layout("layouts/backoffice-layout.tsx", [
    ...prefix("backoffice", [
      index("routes/backoffice/index.tsx"),
      route("organisations", "routes/backoffice/organisations.tsx"),
      route("invitations/:invitationId", "routes/backoffice/invitation-accept.tsx"),
      route("organisations/:orgId", "routes/backoffice/organisation-layout.tsx", [
        index("routes/backoffice/organisation-overview.tsx"),
        route("members", "routes/backoffice/organisation-members.tsx"),
        route("invites", "routes/backoffice/organisation-invites.tsx"),
        route("billing", "routes/backoffice/organisation-billing.tsx"),
      ]),
      route("connections", "routes/backoffice/connections/index.tsx"),
      route("connections/resend", "routes/backoffice/connections/resend/index.tsx"),
      route("connections/reson8", "routes/backoffice/connections/reson8/index.tsx"),
      route("connections/mcp", "routes/backoffice/connections/mcp/index.tsx"),
      route(
        "connections/api/oauth-complete",
        "routes/backoffice/connections/api-oauth-complete.tsx",
      ),
      route("connections/telegram", "routes/backoffice/connections/telegram/index.tsx"),
      route("connections/github", "routes/backoffice/connections/github/index.tsx"),
      route(
        "connections/github/setup-callback",
        "routes/backoffice/connections/github/setup-callback.tsx",
      ),
      route(
        "connections/github/oauth-callback",
        "routes/backoffice/connections/github/oauth-callback.tsx",
      ),
      route("connections/upload", "routes/backoffice/connections/upload/index.tsx"),
      route("automations", "routes/backoffice/automations/index.tsx"),
      route(
        "automations/:orgId/claims/complete",
        "routes/backoffice/automations/claims-complete.tsx",
      ),
      route(
        "automations/:scopeKind/:scopeId/integrations/telegram/attachment-download",
        "routes/backoffice/connections/telegram/attachment-download.ts",
        { id: "scoped-integrations/telegram/attachment-download" },
      ),
      route(
        "automations/:scopeKind/:scopeId/integrations/telegram",
        "routes/backoffice/connections/telegram/organisation-layout.tsx",
        { id: "scoped-integrations/telegram/layout" },
        [
          index("routes/backoffice/connections/telegram/organisation-index.tsx", {
            id: "scoped-integrations/telegram/index",
          }),
          route("configuration", "routes/backoffice/connections/telegram/configuration.tsx", {
            id: "scoped-integrations/telegram/configuration",
          }),
          route(
            "messages",
            "routes/backoffice/connections/telegram/messages.tsx",
            { id: "scoped-integrations/telegram/messages" },
            [
              index("routes/backoffice/connections/telegram/messages-index.tsx", {
                id: "scoped-integrations/telegram/messages-index",
              }),
              route(":chatId", "routes/backoffice/connections/telegram/message-thread.tsx", {
                id: "scoped-integrations/telegram/message-thread",
              }),
            ],
          ),
        ],
      ),
      route(
        "automations/:scopeKind/:scopeId/integrations/resend",
        "routes/backoffice/connections/resend/organisation-layout.tsx",
        { id: "scoped-integrations/resend/layout" },
        [
          route("configuration", "routes/backoffice/connections/resend/configuration.tsx", {
            id: "scoped-integrations/resend/configuration",
          }),
          route(
            "domains",
            "routes/backoffice/connections/resend/domains.tsx",
            { id: "scoped-integrations/resend/domains" },
            [
              index("routes/backoffice/connections/resend/domains-index.tsx", {
                id: "scoped-integrations/resend/domains-index",
              }),
              route(":domainId", "routes/backoffice/connections/resend/domain-detail.tsx", {
                id: "scoped-integrations/resend/domain-detail",
              }),
            ],
          ),
          route(
            "threads",
            "routes/backoffice/connections/resend/threads.tsx",
            { id: "scoped-integrations/resend/threads" },
            [
              index("routes/backoffice/connections/resend/threads-index.tsx", {
                id: "scoped-integrations/resend/threads-index",
              }),
              route("start", "routes/backoffice/connections/resend/thread-start.tsx", {
                id: "scoped-integrations/resend/thread-start",
              }),
              route(":threadId", "routes/backoffice/connections/resend/thread-detail.tsx", {
                id: "scoped-integrations/resend/thread-detail",
              }),
            ],
          ),
          route(
            "incoming",
            "routes/backoffice/connections/resend/incoming.tsx",
            { id: "scoped-integrations/resend/incoming" },
            [
              index("routes/backoffice/connections/resend/incoming-index.tsx", {
                id: "scoped-integrations/resend/incoming-index",
              }),
              route(":emailId", "routes/backoffice/connections/resend/incoming-detail.tsx", {
                id: "scoped-integrations/resend/incoming-detail",
              }),
            ],
          ),
          route(
            "outgoing",
            "routes/backoffice/connections/resend/outbox.tsx",
            { id: "scoped-integrations/resend/outbox" },
            [
              index("routes/backoffice/connections/resend/outbox-index.tsx", {
                id: "scoped-integrations/resend/outbox-index",
              }),
              route("send", "routes/backoffice/connections/resend/send.tsx", {
                id: "scoped-integrations/resend/send",
              }),
              route(":emailId", "routes/backoffice/connections/resend/outbox-detail.tsx", {
                id: "scoped-integrations/resend/outbox-detail",
              }),
            ],
          ),
        ],
      ),
      route(
        "automations/:scopeKind/:scopeId/integrations/github",
        "routes/backoffice/connections/github/organisation-layout.tsx",
        { id: "scoped-integrations/github/layout" },
        [
          index("routes/backoffice/connections/github/organisation-index.tsx", {
            id: "scoped-integrations/github/index",
          }),
          route("configuration", "routes/backoffice/connections/github/configuration.tsx", {
            id: "scoped-integrations/github/configuration",
          }),
          route(
            "repositories",
            "routes/backoffice/connections/github/repositories.tsx",
            { id: "scoped-integrations/github/repositories" },
            [
              index("routes/backoffice/connections/github/repositories-index.tsx", {
                id: "scoped-integrations/github/repositories-index",
              }),
              route(":repoId", "routes/backoffice/connections/github/repository-detail.tsx", {
                id: "scoped-integrations/github/repository-detail",
              }),
            ],
          ),
        ],
      ),
      route("automations/:scopeKind/:scopeId", "routes/backoffice/automations/scope-layout.tsx", [
        index("routes/backoffice/automations/scope-index.tsx"),
        route("terminal", "routes/backoffice/automations/terminal.tsx"),
        route("scripts", "routes/backoffice/automations/scripts.tsx"),
        route("router", "routes/backoffice/automations/router.tsx"),
        route("store", "routes/backoffice/automations/store.tsx"),
        route("api", "routes/backoffice/automations/api.tsx"),
        route("integrations", "routes/backoffice/automations/integrations.tsx"),
        route("events", "routes/backoffice/automations/events.tsx"),
        route("events-catalog", "routes/backoffice/automations/events-catalog.tsx"),
        route("mcp", "routes/backoffice/automations/mcp.tsx"),
        route("sandboxes", "routes/backoffice/automations/sandboxes.tsx"),
      ]),

      route(
        "connections/reson8/:orgId",
        "routes/backoffice/connections/reson8/organisation-layout.tsx",
        [
          index("routes/backoffice/connections/reson8/organisation-index.tsx"),
          route("configuration", "routes/backoffice/connections/reson8/configuration.tsx"),
          route("custom-models", "routes/backoffice/connections/reson8/custom-models.tsx"),
          route("transcribe", "routes/backoffice/connections/reson8/transcribe.tsx"),
        ],
      ),
      route("connections/mcp/:orgId", "routes/backoffice/connections/mcp/organisation-layout.tsx", [
        index("routes/backoffice/connections/mcp/organisation-index.tsx"),
        route("configuration", "routes/backoffice/connections/mcp/configuration.tsx"),
        route("oauth-complete", "routes/backoffice/connections/mcp/oauth-complete.tsx"),
      ]),
      route(
        "connections/upload/:orgId",
        "routes/backoffice/connections/upload/organisation-layout.tsx",
        [
          route("configuration", "routes/backoffice/connections/upload/configuration.tsx"),
          route("uploads", "routes/backoffice/connections/upload/uploads.tsx"),
          route("files", "routes/backoffice/connections/upload/files.tsx", [
            index("routes/backoffice/connections/upload/files-index.tsx"),
          ]),
        ],
      ),
      route("sessions", "routes/backoffice/sessions/index.tsx"),
      route("sessions/:orgId", "routes/backoffice/sessions/organisation-layout.tsx", [
        index("routes/backoffice/sessions/organisation-index.tsx"),
        route("configuration", "routes/backoffice/sessions/configuration.tsx"),
        route("harnesses", "routes/backoffice/sessions/harnesses.tsx"),
        route("sessions", "routes/backoffice/sessions/sessions.tsx", [
          index("routes/backoffice/sessions/sessions-index.tsx"),
          route(":workflowName/:sessionId", "routes/backoffice/sessions/session-detail.tsx"),
          route(
            ":workflowName/:sessionId/debug",
            "routes/backoffice/sessions/debug-session-detail.tsx",
          ),
        ]),
      ]),
      route("files", "routes/backoffice/files/index.tsx"),
      route("files/:orgId/download", "routes/backoffice/files/download.ts"),
      route("files/:orgId", "routes/backoffice/files/organisation-layout.tsx", [
        index("routes/backoffice/files/explorer.tsx"),
      ]),
      route("internals", "routes/backoffice/internals/index.tsx"),
      route("internals/github", "routes/backoffice/internals/github.tsx"),
      route("internals/durable-hooks", "routes/backoffice/internals/durable-hooks.tsx"),
      route("internals/workflows", "routes/backoffice/internals/workflows.tsx"),
      route(
        "internals/durable-hooks/singletons",
        "routes/backoffice/internals/durable-hooks-singletons.tsx",
        [
          index("routes/backoffice/internals/durable-hooks-singletons-index.tsx"),
          route(":hookId", "routes/backoffice/internals/durable-hooks-singletons-detail.tsx"),
        ],
      ),
      route(
        "internals/durable-hooks/:orgId",
        "routes/backoffice/internals/durable-hooks-organisation-redirect.tsx",
      ),
      route(
        "internals/durable-hooks/:orgId/:fragment",
        "routes/backoffice/internals/durable-hooks-organisation.tsx",
        [
          index("routes/backoffice/internals/durable-hooks-organisation-index.tsx"),
          route(":hookId", "routes/backoffice/internals/durable-hooks-organisation-detail.tsx"),
        ],
      ),
      route(
        "internals/workflows/:orgId",
        "routes/backoffice/internals/workflows-organisation-redirect.tsx",
      ),
      route(
        "internals/workflows/:orgId/:fragment",
        "routes/backoffice/internals/workflows-organisation.tsx",
        [
          index("routes/backoffice/internals/workflows-organisation-index.tsx"),
          route(
            ":workflowName/:instanceId",
            "routes/backoffice/internals/workflows-organisation-detail.tsx",
          ),
        ],
      ),
      route("users", "routes/backoffice/users.tsx"),
      route("settings", "routes/backoffice/settings.tsx"),
      route("*", "routes/backoffice/not-found.tsx"),
    ]),
  ]),

  route("__dev/codemode/:orgId/SYSTEM.md", "routes/dev/codemode-system-md.ts"),
  route("__dev/codemode/:orgId/bash", "routes/dev/codemode-bash.ts"),
  route("__dev/codemode/:orgId", "routes/dev/codemode.ts"),

  ...prefix("api", [
    route("auth/*", "routes/api/auth.ts"),
    route("resend/:scopeSegment/*", "routes/api/resend.ts"),
    route("reson8/:orgId/*", "routes/api/reson8.ts"),
    route("mcp/:scopeSegment/*", "routes/api/mcp.ts"),
    route("http/:scopeSegment/*", "routes/api/api.ts"),
    route("telegram/:scopeSegment/*", "routes/api/telegram.ts"),
    route("otp/:orgId/*", "routes/api/otp.ts"),
    route("github/webhooks", "routes/api/github-webhooks.ts"),
    route("github/:orgId/*", "routes/api/github.ts"),
    route("upload/:orgId/*", "routes/api/upload.ts"),
    route("pi/:scopeSegment/*", "routes/api/pi.ts"),
    route("pi-workflows/:scopeSegment/*", "routes/api/workflows.ts"),
    route("automations-scoped/:scopeKind/:scopeId/*", "routes/api/automations-scoped.ts"),
    route("automations/:orgId/*", "routes/api/automations.ts"),
    route("automations-workflows/:orgId/*", "routes/api/automations-workflows.ts"),
  ]),
] satisfies RouteConfig;
