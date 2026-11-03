import { z } from "zod";

import { builtJavaScriptModuleSchema } from "@/fragno/codemode/built-javascript-module";

import type { SiteStore } from "./site-store.server";

/** A file a site serves at its URL path, such as `/index.html`, stored as `siteObjectFile` names. */
export type SiteFile = { contentType: string; etag: string };

/**
 * What a build serves, by URL path. Every request to the site consults it, so it is small enough
 * to keep in memory and holds no file contents.
 */
export type SiteIndex = { files: Record<string, SiteFile> };

export type SiteWorker = z.output<typeof builtJavaScriptModuleSchema>;

/**
 * How builds are stored. It is part of every sources fingerprint, so a site built before the
 * layout changed builds anew rather than counting as built by files the server no longer reads.
 */
export const SITE_BUILD_LAYOUT = 3;

/** Written last, so a build that has an index is complete. */
export const SITE_INDEX_FILE = "index.json";

/** The site's Worker, compiled as `js.build` compiles a module; read when an isolate starts. */
export const SITE_WORKER_FILE = "worker.json";

/** Where a build keeps the file the site serves at `path`, such as `public/style.css`. */
export function siteObjectFile(path: string): string {
  return `public${path}`;
}

// Workspace builds are files anyone who may write files may edit, so they are read as input.
const siteIndexFileSchema = z.strictObject({
  version: z.literal(1),
  files: z.record(
    z.string().startsWith("/"),
    z.strictObject({ contentType: z.string(), etag: z.string() }),
  ),
});

export function encodeSiteIndex(index: SiteIndex): string {
  return JSON.stringify({ version: 1, ...index });
}

/** The build's index, or null when it has none, as a build that never finished has not. */
export async function readSiteIndex(store: SiteStore, build: string): Promise<SiteIndex | null> {
  const body = await store.readFile(build, SITE_INDEX_FILE);
  if (body === null) {
    return null;
  }
  const { files } = siteIndexFileSchema.parse(JSON.parse(await new Response(body).text()));
  return { files };
}

/** The build's Worker, or null when the build has none. */
export async function readSiteWorker(store: SiteStore, build: string): Promise<SiteWorker | null> {
  const body = await store.readFile(build, SITE_WORKER_FILE);
  if (body === null) {
    return null;
  }
  return builtJavaScriptModuleSchema.parse(JSON.parse(await new Response(body).text()));
}

/** Every file a build holds, as far as its index lists them. */
export function siteBuildFiles(index: SiteIndex | null): string[] {
  return [
    ...Object.keys(index?.files ?? {}).map(siteObjectFile),
    SITE_WORKER_FILE,
    SITE_INDEX_FILE,
  ];
}
