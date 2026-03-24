import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  layout("layouts/home-layout.tsx", [
    index("routes/home.tsx"),
    route("authors", "routes/authors.tsx"),
    route("fragments", "routes/fragments.tsx"),
    route("fragments/stripe", "routes/stripe.tsx"),
    route("fragments/telegram", "routes/telegram.tsx"),
    route("fragments/forms", "routes/forms/form-index.tsx"),
    route("fragments/workflows", "routes/workflows.tsx"),
    route("fragments/pi", "routes/pi.tsx"),
    route("fragments/resend", "routes/resend.tsx"),
    route("fragments/github", "routes/github.tsx"),
    route("fragments/upload", "routes/upload.tsx"),
    route("fragments/auth", "routes/auth.tsx"),
    route("forms/form-builder.json", "routes/forms/shadcn-registry.ts"),

    route("blog", "routes/blog/blog-index.tsx"),
    route("blog/feed.xml", "routes/blog/feed.ts"),
    route("blog/:slug", "routes/blog/blog-post.tsx"),

    route("docs", "routes/docs/docs-index.tsx"),
    route("docs/*", "routes/docs/docs-page.tsx"),
  ]),

  route("code-preview", "routes/code-preview/code-preview-page.tsx"),
  route("og-image", "routes/og-image/og-image-page.tsx"),

  ...prefix("api", [
    route("search", "routes/api/search.ts"),
    route("markdown/*", "routes/api/markdown.ts"),
    route("forms/*", "routes/api/forms.ts"),
  ]),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
