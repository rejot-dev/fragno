import type { MetadataRoute } from "next";
import { source, blogSource } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://fragno.dev";

  // Homepage
  const homepage: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
  ];

  // All documentation pages
  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${baseUrl}${page.url}`,
    lastModified: page.data.lastModified ?? new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  // All blog posts
  const blogPosts: MetadataRoute.Sitemap = blogSource.getPages().map((post) => ({
    url: `${baseUrl}${post.url}`,
    lastModified: post.data.date ? new Date(post.data.date) : new Date(),
    changeFrequency: "yearly",
    priority: 0.6,
  }));

  // Blog index page
  const blogIndex: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];

  return [...homepage, ...docPages, ...blogIndex, ...blogPosts];
}
