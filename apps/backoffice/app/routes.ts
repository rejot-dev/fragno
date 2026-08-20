import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/landing/index.tsx"),

  route("backoffice/login", "routes/backoffice/login.tsx"),
  route("backoffice/auth/bootstrap", "routes/backoffice/auth-bootstrap.tsx"),
  route("backoffice/sign-up", "routes/backoffice/sign-up.tsx"),
  route("backoffice/verify-email", "routes/backoffice/verify-email.tsx"),
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
      route("connections/resend", "routes/backoffice/connections/resend/index.tsx"),
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
      route("marketplace", "routes/backoffice/marketplace/index.tsx"),
      route("marketplace/publish", "routes/backoffice/marketplace/publish.tsx"),
      route("marketplace/mine", "routes/backoffice/marketplace/mine.tsx"),
      route("marketplace/:scopeKind/:scopeId", "routes/backoffice/marketplace/scope-layout.tsx", [
        index("routes/backoffice/marketplace/scope-index.tsx"),
        route("marketplace", "routes/backoffice/marketplace/marketplace-view.tsx", [
          index("routes/backoffice/marketplace/browse.tsx"),
          route(":listingRef/artifact-file", "routes/backoffice/marketplace/artifact-file.ts"),
          route(":listingRef", "routes/backoffice/marketplace/detail.tsx", [
            index("routes/backoffice/marketplace/artifact-selection.tsx"),
          ]),
        ]),
        route("installed", "routes/backoffice/marketplace/installed.tsx"),
        route("my-listings", "routes/backoffice/marketplace/my-listings.tsx"),
      ]),
      route("marketplace/:listingRef/manage", "routes/backoffice/marketplace/manage.tsx"),
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
        "automations/:scopeKind/:scopeId/integrations/reson8",
        "routes/backoffice/connections/reson8/organisation-layout.tsx",
        { id: "scoped-integrations/reson8/layout" },
        [
          route("configuration", "routes/backoffice/connections/reson8/configuration.tsx", {
            id: "scoped-integrations/reson8/configuration",
          }),
          route("custom-models", "routes/backoffice/connections/reson8/custom-models.tsx", {
            id: "scoped-integrations/reson8/custom-models",
          }),
          route("transcribe", "routes/backoffice/connections/reson8/transcribe.tsx", {
            id: "scoped-integrations/reson8/transcribe",
          }),
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
        route("dashboard", "routes/backoffice/automations/dashboard.tsx"),
        route("terminal-command", "routes/backoffice/automations/terminal-command.ts"),
        route("scripts", "routes/backoffice/automations/scripts.tsx"),
        route("router", "routes/backoffice/automations/router.tsx"),
        route("store", "routes/backoffice/automations/store-layout.tsx", [
          index("routes/backoffice/automations/store.tsx"),
          route("identity-bindings", "routes/backoffice/automations/identity-bindings.tsx"),
        ]),
        route("api", "routes/backoffice/automations/api.tsx"),
        route("integrations", "routes/backoffice/automations/integrations.tsx"),
        route("events", "routes/backoffice/automations/events.tsx"),
        route("events-catalog", "routes/backoffice/automations/events-catalog.tsx"),
        route("mcp", "routes/backoffice/automations/mcp.tsx"),
        route("sandboxes", "routes/backoffice/automations/sandboxes.tsx"),
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
      route("sessions/:scopeKind/:scopeId", "routes/backoffice/sessions/organisation-layout.tsx", [
        index("routes/backoffice/sessions/organisation-index.tsx"),
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
      route("files/:scopeKind/:scopeId/download", "routes/backoffice/files/download.ts"),
      route("files/:scopeKind/:scopeId", "routes/backoffice/files/scope-layout.tsx", [
        index("routes/backoffice/files/explorer.tsx"),
        route("*", "routes/backoffice/files/explorer-path.tsx"),
      ]),
      route("internals", "routes/backoffice/internals/layout.tsx", [
        index("routes/backoffice/internals/index.tsx"),
        route("users", "routes/backoffice/internals/users.tsx"),
        route("github", "routes/backoffice/internals/github.tsx"),
        route("cloudflare/browser-run", "routes/backoffice/internals/cloudflare-browser-run.tsx"),
        route("generated-ui", "routes/backoffice/internals/generated-ui.tsx"),
        route("durable-hooks", "routes/backoffice/internals/durable-hooks.tsx"),
        route("workflows", "routes/backoffice/internals/workflows.tsx"),
        route(
          "durable-hooks/:scopeKind/:scopeId",
          "routes/backoffice/internals/durable-hooks-scope-redirect.tsx",
        ),
        route(
          "durable-hooks/:scopeKind/:scopeId/:objectId",
          "routes/backoffice/internals/durable-hooks-scope-layout.tsx",
          [
            index("routes/backoffice/internals/durable-hooks-scope-index.tsx"),
            route(":hookId", "routes/backoffice/internals/durable-hooks-scope-detail.tsx"),
          ],
        ),
        route(
          "workflows/:scopeKind/:scopeId",
          "routes/backoffice/internals/workflows-organisation.tsx",
          [
            index("routes/backoffice/internals/workflows-organisation-index.tsx"),
            route(
              ":workflowName/:instanceId",
              "routes/backoffice/internals/workflows-organisation-detail.tsx",
            ),
          ],
        ),
      ]),
      route("users", "routes/backoffice/users.tsx"),
      route("settings", "routes/backoffice/settings.tsx"),
      route("*", "routes/backoffice/not-found.tsx"),
    ]),
  ]),

  route("__dev/codemode/:scopeKind/:scopeId/SYSTEM.md", "routes/dev/codemode-system-md.ts"),
  route("__dev/codemode/:scopeKind/:scopeId/bash", "routes/dev/codemode-bash.ts"),
  route("__dev/codemode/:scopeKind/:scopeId", "routes/dev/codemode.ts"),

  ...prefix("api", [
    route("auth/*", "routes/api/auth.ts"),
    route("backoffice/me", "routes/api/backoffice-me.ts"),
    route("cloudflare/*", "routes/api/cloudflare.ts"),
    route("resend/:scopeSegment/*", "routes/api/resend.ts"),
    route("reson8/:orgId/*", "routes/api/reson8.ts"),
    route("mcp/:scopeSegment/*", "routes/api/mcp.ts"),
    route("http/:scopeSegment/*", "routes/api/api.ts"),
    route("telegram/:scopeSegment/*", "routes/api/telegram.ts"),
    route("otp/:orgId/*", "routes/api/otp.ts"),
    route("github/webhooks", "routes/api/github-webhooks.ts"),
    route("github/:orgId/*", "routes/api/github.ts"),
    route("upload/:orgId/*", "routes/api/upload.ts"),
    route("upload-scoped/:scopeKind/:scopeId/*", "routes/api/upload-scoped.ts"),
    route("pi/:scopeSegment/*", "routes/api/pi.ts"),
    route("workflows/:scopeSegment/*", "routes/api/workflows.ts"),
    route("automations-scoped/:scopeKind/:scopeId/*", "routes/api/automations-scoped.ts"),
    route("marketplace/*", "routes/api/marketplace.ts"),
  ]),
] satisfies RouteConfig;
