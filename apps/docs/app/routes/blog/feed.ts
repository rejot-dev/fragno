import type { Route } from "./+types/feed";
import { blogSource } from "@/lib/source";

const BASE_URL = "https://fragno.dev";

export async function loader(_: Route.LoaderArgs) {
  const posts = [...blogSource.getPages()]
    .map((post) => ({
      url: post.url,
      title: post.data.title,
      description: post.data.description,
      date: "date" in post.data ? new Date(post.data.date) : new Date(),
      author: "author" in post.data ? (post.data.author as string) : undefined,
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const lastBuildDate = posts[0]?.date ?? new Date();

  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${BASE_URL}${post.url}</link>
      <guid isPermaLink="true">${BASE_URL}${post.url}</guid>
      <description>${escapeXml(post.description ?? "")}</description>
      <pubDate>${post.date.toUTCString()}</pubDate>${post.author ? `\n      <author>${escapeXml(post.author)}</author>` : ""}
    </item>`,
    )
    .join("\n");

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Fragno Blog</title>
    <link>${BASE_URL}/blog</link>
    <description>Keep up with the Fragno ecosystem.</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>
    <atom:link href="${BASE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
