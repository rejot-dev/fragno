import { createMDXSource } from "fumadocs-mdx";
import { docs, blog } from "@/.source";
import { loader } from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement } from "react";

// See https://fumadocs.vercel.app/docs/headless/source-api for more info
export const source = loader({
  // it assigns a URL to your pages
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  icon(icon) {
    if (icon && icon in icons) return createElement(icons[icon as keyof typeof icons]);
  },
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: createMDXSource(blog),
});
