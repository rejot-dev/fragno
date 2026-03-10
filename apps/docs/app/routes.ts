import { type RouteConfig, index, route, layout, prefix } from "@react-router/dev/routes";

export default [
  layout("layouts/home-layout.tsx", [
    index("routes/home.tsx"),
    route("authors", "routes/authors.tsx"),
    route("fragments", "routes/fragments.tsx"),
    route("fragments/stripe", "routes/stripe.tsx"),
    route("fragments/telegram", "routes/telegram.tsx"),
    route("fragments/workflows", "routes/workflows.tsx"),
    route("fragments/upload", "routes/upload.tsx"),
    route("fragments/auth", "routes/auth.tsx"),

    route("blog", "routes/blog/blog-index.tsx"),
    route("blog/feed.xml", "routes/blog/feed.ts"),
    route("blog/:slug", "routes/blog/blog-post.tsx"),

    route("docs", "routes/docs/docs-index.tsx"),
    route("docs/*", "routes/docs/docs-page.tsx"),
    route("fragments/forms", "routes/forms/form-index.tsx"),
    route("forms/form-builder.json", "routes/forms/shadcn-registry.ts"),
  ]),

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
      route("connections/telegram", "routes/backoffice/connections/telegram/index.tsx"),
      route("environments", "routes/backoffice/environments/index.tsx"),
      route("environments/cf-sandbox", "routes/backoffice/environments/cf-sandbox.tsx"),
      route(
        "connections/resend/:orgId",
        "routes/backoffice/connections/resend/organisation-layout.tsx",
        [
          route("configuration", "routes/backoffice/connections/resend/configuration.tsx"),
          route("send", "routes/backoffice/connections/resend/send.tsx"),
          route("outbox", "routes/backoffice/connections/resend/outbox.tsx", [
            index("routes/backoffice/connections/resend/outbox-index.tsx"),
            route(":emailId", "routes/backoffice/connections/resend/outbox-detail.tsx"),
          ]),
        ],
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
      route("internals", "routes/backoffice/internals/index.tsx"),
      route("internals/durable-hooks", "routes/backoffice/internals/durable-hooks.tsx"),
      route("internals/workflows", "routes/backoffice/internals/workflows.tsx"),
      route(
        "internals/durable-hooks/singletons",
        "routes/backoffice/internals/durable-hooks-singletons.tsx",
        [index("routes/backoffice/internals/durable-hooks-singletons-index.tsx")],
      ),
      route(
        "internals/durable-hooks/:orgId",
        "routes/backoffice/internals/durable-hooks-organisation-redirect.tsx",
      ),
      route(
        "internals/durable-hooks/:orgId/:fragment",
        "routes/backoffice/internals/durable-hooks-organisation.tsx",
        [index("routes/backoffice/internals/durable-hooks-organisation-index.tsx")],
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

  route("code-preview", "routes/code-preview/code-preview-page.tsx"),
  route("og-image", "routes/og-image/og-image-page.tsx"),

  ...prefix("api", [
    route("search", "routes/api/search.ts"),
    route("markdown/*", "routes/api/markdown.ts"),
    route("forms/*", "routes/api/forms.ts"),
    route("auth/*", "routes/api/auth.ts"),
    route("resend/:orgId/*", "routes/api/resend.ts"),
    route("telegram/:orgId/*", "routes/api/telegram.ts"),
    route("pi/:orgId/*", "routes/api/pi.ts"),
    route("workflows/:orgId/*", "routes/api/workflows.ts"),
  ]),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
