import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  route("backoffice/login", "routes/backoffice/login.tsx"),
  route("backoffice/sign-up", "routes/backoffice/sign-up.tsx"),
  layout("layouts/backoffice-layout.tsx", [
    ...prefix("backoffice", [
      index("routes/backoffice/dashboard.tsx"),
      route("organisations", "routes/backoffice/organisations.tsx"),
      route("invitations/:invitationId", "routes/backoffice/invitation-accept.tsx"),
      route("organisations/:orgId", "routes/backoffice/organisation-layout.tsx", [
        index("routes/backoffice/organisation-overview.tsx"),
        route("members", "routes/backoffice/organisation-members.tsx"),
        route("invites", "routes/backoffice/organisation-invites.tsx"),
      ]),
      route("connections", "routes/backoffice/connections/index.tsx"),
      route("connections/resend", "routes/backoffice/connections/resend/index.tsx"),
      route("connections/reson8", "routes/backoffice/connections/reson8/index.tsx"),
      route("connections/telegram", "routes/backoffice/connections/telegram/index.tsx"),
      route("connections/github", "routes/backoffice/connections/github/index.tsx"),
      route(
        "connections/github/setup-callback",
        "routes/backoffice/connections/github/setup-callback.tsx",
      ),
      route("connections/upload", "routes/backoffice/connections/upload/index.tsx"),
      route("automations", "routes/backoffice/automations/index.tsx"),
      route(
        "automations/:orgId/claims/complete",
        "routes/backoffice/automations/claims-complete.tsx",
      ),
      route("automations/:orgId", "routes/backoffice/automations/organisation-layout.tsx", [
        index("routes/backoffice/automations/organisation-index.tsx"),
        route("scripts", "routes/backoffice/automations/scripts.tsx"),
        route("identity", "routes/backoffice/automations/identity.tsx"),
      ]),
      route("environments", "routes/backoffice/environments/index.tsx"),
      route("environments/workers", "routes/backoffice/environments/workers.tsx"),
      route("environments/cf-sandbox", "routes/backoffice/environments/cf-sandbox.tsx"),
      route(
        "connections/resend/:orgId",
        "routes/backoffice/connections/resend/organisation-layout.tsx",
        [
          route("configuration", "routes/backoffice/connections/resend/configuration.tsx"),
          route("domains", "routes/backoffice/connections/resend/domains.tsx", [
            index("routes/backoffice/connections/resend/domains-index.tsx"),
            route(":domainId", "routes/backoffice/connections/resend/domain-detail.tsx"),
          ]),
          route("threads", "routes/backoffice/connections/resend/threads.tsx", [
            index("routes/backoffice/connections/resend/threads-index.tsx"),
            route("start", "routes/backoffice/connections/resend/thread-start.tsx"),
            route(":threadId", "routes/backoffice/connections/resend/thread-detail.tsx"),
          ]),
          route("incoming", "routes/backoffice/connections/resend/incoming.tsx", [
            index("routes/backoffice/connections/resend/incoming-index.tsx"),
            route(":emailId", "routes/backoffice/connections/resend/incoming-detail.tsx"),
          ]),
          route("outgoing", "routes/backoffice/connections/resend/outbox.tsx", [
            index("routes/backoffice/connections/resend/outbox-index.tsx"),
            route("send", "routes/backoffice/connections/resend/send.tsx"),
            route(":emailId", "routes/backoffice/connections/resend/outbox-detail.tsx"),
          ]),
        ],
      ),
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
      route(
        "connections/telegram/:orgId/attachment-download",
        "routes/backoffice/connections/telegram/attachment-download.ts",
      ),
      route(
        "connections/telegram/:orgId",
        "routes/backoffice/connections/telegram/organisation-layout.tsx",
        [
          index("routes/backoffice/connections/telegram/organisation-index.tsx"),
          route("configuration", "routes/backoffice/connections/telegram/configuration.tsx"),
          route("messages", "routes/backoffice/connections/telegram/messages.tsx", [
            index("routes/backoffice/connections/telegram/messages-index.tsx"),
            route(":chatId", "routes/backoffice/connections/telegram/message-thread.tsx"),
          ]),
        ],
      ),
      route(
        "connections/github/:orgId",
        "routes/backoffice/connections/github/organisation-layout.tsx",
        [
          index("routes/backoffice/connections/github/organisation-index.tsx"),
          route("configuration", "routes/backoffice/connections/github/configuration.tsx"),
          route("repositories", "routes/backoffice/connections/github/repositories.tsx", [
            index("routes/backoffice/connections/github/repositories-index.tsx"),
            route(":repoId", "routes/backoffice/connections/github/repository-detail.tsx"),
          ]),
        ],
      ),
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
          route(":sessionId", "routes/backoffice/sessions/session-detail.tsx"),
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

  route("__dev/workers/:orgId/:appId/*", "routes/dev/cloudflare-worker-proxy.ts"),

  ...prefix("api", [
    route("auth/*", "routes/api/auth.ts"),
    route("cloudflare/:orgId/*", "routes/api/cloudflare.ts"),
    route("resend/:orgId/*", "routes/api/resend.ts"),
    route("reson8/:orgId/*", "routes/api/reson8.ts"),
    route("telegram/:orgId/*", "routes/api/telegram.ts"),
    route("otp/:orgId/*", "routes/api/otp.ts"),
    route("github/webhooks", "routes/api/github-webhooks.ts"),
    route("github/:orgId/*", "routes/api/github.ts"),
    route("upload/:orgId/*", "routes/api/upload.ts"),
    route("pi/:orgId/*", "routes/api/pi.ts"),
    route("automations/:orgId/*", "routes/api/automations.ts"),
    route("workflows/:orgId/*", "routes/api/workflows.ts"),
  ]),
] satisfies RouteConfig;
