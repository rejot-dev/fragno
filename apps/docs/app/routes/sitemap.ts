import type { Route } from "./+types/sitemap";
import { source, blogSource } from "@/lib/source";

export async function loader(_: Route.LoaderArgs) {
  const baseUrl = "https://fragno.dev";

  // Homepage
  const homepageEntry = `
  <url>
    <loc>${baseUrl}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;

  const authorEntry = `
  <url>
    <loc>${baseUrl}/authors</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;

  const fragmentPages = [
    "/fragments",
    "/fragments/forms",
    "/fragments/stripe",
    "/fragments/workflows",
    "/fragments/upload",
    "/fragments/auth",
  ];

  const fragmentEntries = fragmentPages
    .map((path) => {
      return `
  <url>
    <loc>${baseUrl}${path}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    })
    .join("");

  // All documentation pages
  const docPages = source
    .getPages()
    .map((page) => {
      return `
  <url>
    <loc>${baseUrl}${page.url}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    })
    .join("");

  // Blog index page
  const blogIndexEntry = `
  <url>
    <loc>${baseUrl}/blog</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;

  // All blog posts
  const blogPosts = blogSource
    .getPages()
    .map((post) => {
      // Blog posts have a date property we can use
      const date = "date" in post.data ? post.data.date : undefined;
      const lastModified = date ? new Date(date).toISOString() : new Date().toISOString();

      return `
  <url>
    <loc>${baseUrl}${post.url}</loc>
    <lastmod>${lastModified}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.6</priority>
  </url>`;
    })
    .join("");

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${homepageEntry}${authorEntry}${fragmentEntries}${docPages}${blogIndexEntry}${blogPosts}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
