import { type RouteConfig, index, route, layout, prefix } from "@react-router/dev/routes";

export default [
  layout("layouts/home-layout.tsx", [
    index("routes/home.tsx"),
    route("authors", "routes/authors.tsx"),
    route("fragments", "routes/fragments.tsx"),
    route("fragments/stripe", "routes/stripe.tsx"),
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
  layout("layouts/backoffice-layout.tsx", [
    route("backoffice", "routes/backoffice/dashboard.tsx"),
    route("backoffice/organisations", "routes/backoffice/organisations.tsx"),
    route("backoffice/users", "routes/backoffice/users.tsx"),
    route("backoffice/settings", "routes/backoffice/settings.tsx"),
  ]),

  route("code-preview", "routes/code-preview/code-preview-page.tsx"),
  route("og-image", "routes/og-image/og-image-page.tsx"),

  ...prefix("api", [
    route("search", "routes/api/search.ts"),
    route("markdown/*", "routes/api/markdown.ts"),
    route("forms/*", "routes/api/forms.ts"),
    route("auth/*", "routes/api/auth.ts"),
  ]),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
