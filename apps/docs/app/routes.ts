import { type RouteConfig, index, route, layout, prefix } from "@react-router/dev/routes";

export default [
  layout("layouts/home-layout.tsx", [
    index("routes/home.tsx"),

    route("blog", "routes/blog/blog-index.tsx"),
    route("blog/:slug", "routes/blog/blog-post.tsx"),

    route("docs", "routes/docs/docs-index.tsx"),
    route("docs/*", "routes/docs/docs-page.tsx"),
  ]),

  route("code-preview", "routes/code-preview/code-preview-page.tsx"),
  route("og-image", "routes/og-image/og-image-page.tsx"),

  ...prefix("api", [
    route("search", "routes/api/search.ts"),
    route("markdown/*", "routes/api/markdown.ts"),
  ]),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
