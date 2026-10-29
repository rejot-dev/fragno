import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

import { BACKOFFICE_LAYOUT_ROUTE_ID } from "./routes/backoffice/route-ids";

export default [
  index("routes/landing/index.tsx"),
  route("forms/:scopeKind/:scopeId/:slug", "routes/forms/form.tsx"),
  route("marketplace", "routes/marketplace/index.tsx"),
  route("marketplace/:publisher/:packageSlug", "routes/marketplace/listing.tsx"),

  route("backoffice/login", "routes/backoffice/login.tsx"),
  route("backoffice/forgot-password", "routes/backoffice/forgot-password.tsx"),
  route("backoffice/reset-password", "routes/backoffice/reset-password.tsx"),
  route("backoffice/device", "routes/backoffice/device.tsx"),
  route("backoffice/oauth/consent", "routes/backoffice/oauth-consent.tsx"),
  route("backoffice/apps/install", "routes/backoffice/app-install.tsx"),
  route("backoffice/sign-up", "routes/backoffice/sign-up.tsx"),
  route("backoffice/verify-email", "routes/backoffice/verify-email.tsx"),
  // Outside the Backoffice shell, which opens the person's own scope before they choose where it is
  // kept.
  route("backoffice/onboarding", "routes/backoffice/onboarding.tsx"),
  route("backoffice/presence", "routes/backoffice/presence.ts"),
  layout("layouts/backoffice-layout.tsx", { id: BACKOFFICE_LAYOUT_ROUTE_ID }, [
    ...prefix("backoffice", [
      index("routes/backoffice/index.tsx"),
      route("organizations", "routes/backoffice/organizations.tsx"),
      route("usage", "routes/backoffice/organization-billing.tsx", { id: "personal-usage" }),
      route("dashboard", "routes/backoffice/dashboard/index.tsx"),
      route("dashboard/:scopeKind/:scopeId", "routes/backoffice/dashboard/dashboard.tsx"),
      route("dashboard/:scopeKind/:scopeId/activity", "routes/backoffice/dashboard/activity.tsx"),
      route("dashboard/:scopeKind/:scopeId/map", "routes/backoffice/dashboard/map.tsx"),
      route("dashboard/:scopeKind/:scopeId/pages/*", "routes/backoffice/pages/page.tsx"),
      route("invitations/:invitationId", "routes/backoffice/invitation-accept.tsx"),
      route("organizations/:orgSlug", "routes/backoffice/organization-layout.tsx", [
        index("routes/backoffice/organization-overview.tsx"),
        route("members", "routes/backoffice/organization-members.tsx"),
        route("invites", "routes/backoffice/organization-invites.tsx"),
        route("clients", "routes/backoffice/organization-clients.tsx"),
        route("billing", "routes/backoffice/organization-billing.tsx"),
      ]),
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
        route(":catalog", "routes/backoffice/marketplace/marketplace-view.tsx", [
          index("routes/backoffice/marketplace/browse.tsx"),
          route("all", "routes/backoffice/marketplace/browse-all.tsx"),
          route(
            ":publisher/:packageSlug/package-file",
            "routes/backoffice/marketplace/package-file.ts",
          ),
          route(":publisher/:packageSlug", "routes/backoffice/marketplace/detail.tsx", [
            index("routes/backoffice/marketplace/package-selection.tsx"),
          ]),
        ]),
        route("my-listings", "routes/backoffice/marketplace/my-listings.tsx"),
      ]),
      route(
        "marketplace/:publisher/:packageSlug/manage",
        "routes/backoffice/marketplace/manage.tsx",
      ),
      route("claims/:orgSlug/complete", "routes/backoffice/claims-complete.tsx"),
      route("terminal/:scopeKind/:scopeId", "routes/backoffice/terminal-command.ts"),

      route(
        "connections/upload/:orgSlug",
        "routes/backoffice/connections/upload/organization-layout.tsx",
        [
          route("uploads", "routes/backoffice/connections/upload/uploads.tsx"),
          route("files", "routes/backoffice/connections/upload/files.tsx", [
            index("routes/backoffice/connections/upload/files-index.tsx"),
          ]),
        ],
      ),
      route("computers", "routes/backoffice/computers/index.tsx"),
      route("computers/:scopeKind/:scopeId", "routes/backoffice/computers/scope-layout.tsx", [
        index("routes/backoffice/computers/scope-index.tsx"),
        route("sandboxes", "routes/backoffice/computers/sandboxes.tsx", [
          index("routes/backoffice/computers/sandboxes-index.tsx"),
          route("new", "routes/backoffice/computers/sandbox-new.tsx"),
          route(":sandboxId", "routes/backoffice/computers/sandbox-detail.tsx"),
        ]),
      ]),
      route("agents", "routes/backoffice/agents/index.tsx"),
      route("agents/:scopeKind/:scopeId", "routes/backoffice/agents/organization-layout.tsx", [
        index("routes/backoffice/agents/organization-index.tsx"),
        route("agents", "routes/backoffice/agents/agents.tsx", [
          index("routes/backoffice/agents/agents-index.tsx"),
          route(":agentName", "routes/backoffice/agents/agent-detail.tsx"),
          route(":agentName/view-socket", "routes/backoffice/agents/agent-view-socket.ts"),
          route(":agentName/drawer", "routes/backoffice/agents/agent-drawer-data.ts"),
          route(":agentName/entries", "routes/backoffice/agents/agent-entries.ts"),
          route(":agentName/export", "routes/backoffice/agents/agent-export.ts"),
          route(":agentName.jsonl", "routes/backoffice/agents/agent-export.ts", {
            id: "agents/agent-jsonl",
          }),
          route(":agentName/subagents", "routes/backoffice/agents/agent-subagents.ts"),
          route(
            ":agentName/subagents/:requestId",
            "routes/backoffice/agents/agent-subagent-view.ts",
          ),
          route(":agentName/messages", "routes/backoffice/agents/agent-messages.ts"),
          route(":agentName/compactions", "routes/backoffice/agents/agent-compactions.ts"),
          route(":agentName/compactions/:taskId", "routes/backoffice/agents/agent-compaction.ts"),
          route(":agentName/debug", "routes/backoffice/agents/debug-agent-detail.tsx"),
        ]),
      ]),
      route("files", "routes/backoffice/files/index.tsx"),
      route("files/:scopeKind/:scopeId/download", "routes/backoffice/files/download.ts"),
      route("files/:scopeKind/:scopeId/preview", "routes/backoffice/files/preview.ts"),
      route(
        "files/:scopeKind/:scopeId/large-files/download",
        "routes/backoffice/files/large-files-download.ts",
      ),
      route("files/:scopeKind/:scopeId", "routes/backoffice/files/scope-layout.tsx", [
        index("routes/backoffice/files/explorer.tsx"),
        route("large-files", "routes/backoffice/files/large-files.tsx"),
        route("*", "routes/backoffice/files/explorer-path.tsx"),
      ]),
      route("integrations", "routes/backoffice/integrations/index.tsx"),
      route(
        "integrations/:scopeKind/:scopeId/telegram/attachment-download",
        "routes/backoffice/connections/telegram/attachment-download.ts",
        { id: "scoped-integrations/telegram/attachment-download" },
      ),
      route(
        "integrations/:scopeKind/:scopeId/telegram",
        "routes/backoffice/connections/telegram/organization-layout.tsx",
        { id: "scoped-integrations/telegram/layout" },
        [
          index("routes/backoffice/connections/telegram/organization-index.tsx", {
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
        "integrations/:scopeKind/:scopeId/resend",
        "routes/backoffice/connections/resend/organization-layout.tsx",
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
        "integrations/:scopeKind/:scopeId/github",
        "routes/backoffice/connections/github/organization-layout.tsx",
        { id: "scoped-integrations/github/layout" },
        [
          index("routes/backoffice/connections/github/organization-index.tsx", {
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
      route(
        "integrations/:scopeKind/:scopeId/forms",
        "routes/backoffice/connections/forms/index.tsx",
        {
          id: "scoped-integrations/forms",
        },
      ),
      route(
        "integrations/:scopeKind/:scopeId/forms/:formId",
        "routes/backoffice/connections/forms/detail.tsx",
      ),
      route("integrations/:scopeKind/:scopeId", "routes/backoffice/integrations/scope-layout.tsx", [
        route(":connectionId", "routes/backoffice/integrations/connection-detail.tsx"),
      ]),
      route("internals", "routes/backoffice/internals/redirect.tsx"),
      route("internals/:scopeKind/:scopeId", "routes/backoffice/internals/layout.tsx", [
        index("routes/backoffice/internals/index.tsx"),
        route("users", "routes/backoffice/internals/users.tsx"),
        route("access-codes", "routes/backoffice/internals/access-codes.tsx"),
        route("access-codes/:code", "routes/backoffice/internals/access-code-redemptions.tsx"),
        route("github", "routes/backoffice/internals/github.tsx"),
        route("cloudflare/browser-run", "routes/backoffice/internals/cloudflare-browser-run.tsx"),
        route("generated-ui", "routes/backoffice/internals/generated-ui.tsx"),
        route("durable-hooks", "routes/backoffice/internals/durable-hooks-scope-redirect.tsx"),
        route(
          "durable-hooks/:objectId",
          "routes/backoffice/internals/durable-hooks-scope-layout.tsx",
          [
            index("routes/backoffice/internals/durable-hooks-scope-index.tsx"),
            route(":hookId", "routes/backoffice/internals/durable-hooks-scope-detail.tsx"),
          ],
        ),
        route("codemode", "routes/backoffice/internals/codemode-runs.tsx", [
          index("routes/backoffice/internals/codemode-runs-index.tsx"),
          route(":runId", "routes/backoffice/internals/codemode-run-detail.tsx"),
        ]),
        route("workflows", "routes/backoffice/internals/workflows-organization.tsx", [
          index("routes/backoffice/internals/workflows-organization-index.tsx"),
          route(
            ":workflowName/:instanceId",
            "routes/backoffice/internals/workflows-organization-detail.tsx",
          ),
        ]),
      ]),
      route("users", "routes/backoffice/users.tsx"),
      route("settings", "routes/backoffice/settings.tsx"),
      route("settings/authorized-applications", "routes/backoffice/authorized-applications.tsx"),
      route("*", "routes/backoffice/not-found.tsx"),
    ]),
  ]),

  route(
    "api/backoffice/codemode/:scopeKind/:scopeId/SYSTEM.md",
    "routes/api/backoffice-codemode-system-md.ts",
  ),
  route(
    "api/backoffice/codemode/:scopeKind/:scopeId/bash",
    "routes/api/backoffice-codemode-bash.ts",
  ),
  route("api/backoffice/codemode/:scopeKind/:scopeId", "routes/api/backoffice-codemode.ts"),

  ...prefix("api", [
    route("admin/grant", "routes/api/admin-grant.ts"),
    route("auth/*", "routes/api/auth.ts"),
    route("backoffice/cli-config", "routes/api/backoffice-cli-config.ts"),
    route("backoffice/execution-token", "routes/api/backoffice-execution-token.ts"),
    route("backoffice/me", "routes/api/backoffice-me.ts"),
    route("backoffice/app-installations/claim", "routes/api/backoffice-app-installation-claim.ts"),
    route("cloudflare/*", "routes/api/cloudflare.ts"),
    route("forms/*", "routes/api/forms.ts"),
    route("resend/:scopeSegment/*", "routes/api/resend.ts"),
    route("reson8/:scopeSegment/auth/token", "routes/api/reson8-token.ts"),
    route("mcp/:scopeSegment/servers/:serverSlug/auth/start", "routes/api/mcp-oauth-start.ts"),
    route("mcp/:scopeSegment/*", "routes/api/mcp.ts"),
    route("connector/:scopeSegment/*", "routes/api/project-connector.ts"),
    route(
      "http/:scopeSegment/connections/:connectionSlug/auth/oauth/start",
      "routes/api/api-oauth-start.ts",
    ),
    route("http/:scopeSegment/*", "routes/api/api.ts"),
    route("telegram/:scopeSegment/*", "routes/api/telegram.ts"),
    route("otp/:orgSlug/*", "routes/api/otp.ts"),
    route("github/webhooks", "routes/api/github-webhooks.ts"),
    route("upload/:orgSlug/*", "routes/api/upload.ts"),
    route("files-scoped/:scopeKind/:scopeId/workspace", "routes/api/files-scoped-workspace.ts"),
    route(
      "files-scoped/:scopeKind/:scopeId/large-files/uploads",
      "routes/api/large-files-uploads.ts",
    ),
    route("file-links/:scopeKind/:scopeId/*", "routes/api/file-links.ts"),
    route("upload-scoped/:scopeKind/:scopeId/*", "routes/api/upload-scoped.ts"),
    route("workflows/:scopeSegment/*", "routes/api/workflows.ts"),
    route("automations-scoped/:scopeKind/:scopeId/*", "routes/api/automations-scoped.ts"),
    route("marketplace/*", "routes/api/marketplace.ts"),
  ]),
] satisfies RouteConfig;
