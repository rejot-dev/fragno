import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { readSiteIndex, siteObjectFile, type SiteIndex } from "./site-build.server";
import { siteStore, type SiteStore } from "./site-store.server";

/**
 * Names the build whose files a site's `env.ASSETS` serves. The host sets them when it loads the
 * site's Worker, so a site reaches only its own build.
 */
export type SiteAssetsProps = { scope: BackofficeContextScope; sitePath: string; build: string };

/** What a site Worker calls as `env.ASSETS`. */
export type SiteAssetsBinding = { fetch(request: Request): Promise<Response> };

/**
 * Where build files are cached: the cache of the zone `origin` belongs to, under keys at that
 * origin, and how a cache write outlives the response it copies.
 */
export type SiteFilesCache = {
  store: Cache;
  origin: string;
  waitUntil(promise: Promise<unknown>): void;
};

/** The runtime's cache of site files, keyed under the origin of the request reading them. */
export function siteFilesCacheFor(
  runtime: BackofficeRuntimeServices,
  request: Request,
  waitUntil: (promise: Promise<unknown>) => void,
): SiteFilesCache | null {
  return runtime.siteFilesCache
    ? { store: runtime.siteFilesCache, origin: new URL(request.url).origin, waitUntil }
    : null;
}

/**
 * The site's store, reading build files through the cache when there is one. Callers have already
 * admitted the viewer, so it reads the workspace as the system.
 */
export function siteStoreForServing({
  runtime,
  scope,
  sitePath,
  cache,
}: {
  runtime: BackofficeRuntimeServices;
  scope: BackofficeContextScope;
  sitePath: string;
  cache: SiteFilesCache | null;
}): SiteStore {
  const { stateBackend } = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime,
    kernel: new BackofficeKernel(runtime),
    execution: createBackofficeSystemExecution(scope),
  });
  if (!stateBackend) {
    throw new Error(`${sitePath} has no workspace in this runtime.`);
  }
  const store = siteStore({
    siteStorage: runtime.siteStorage,
    state: stateBackend,
    scope,
    sitePath,
  });
  return cache ? cachedSiteStore(store, cache, scope, sitePath) : store;
}

/** Builds never change once written, so a file read once is kept as long as the cache holds it. */
function cachedSiteStore(
  store: SiteStore,
  cache: SiteFilesCache,
  scope: BackofficeContextScope,
  sitePath: string,
): SiteStore {
  return {
    ...store,
    async readFile(build, file) {
      const segments = [backofficeScopePathSegment(scope), ...sitePath.split("/").slice(2), build];
      const cacheKey = new Request(
        `${cache.origin}/__sites/${[...segments, ...file.split("/")].map(encodeURIComponent).join("/")}`,
      );
      const cached = await cache.store.match(cacheKey);
      if (cached) {
        return cached.body;
      }
      const body = await store.readFile(build, file);
      if (body === null) {
        return null;
      }
      const response = new Response(body, {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      });
      cache.waitUntil(cache.store.put(cacheKey, response.clone()));
      return response.body;
    },
  };
}

// Indexes never change either, so each isolate keeps those it read lately, up to about this many
// bytes of them. They share the memory of the Worker that serves Backoffice, so the cap is small.
const INDEXES_KEPT_BYTES = 1024 * 1024;
const indexes = new Map<string, { index: SiteIndex; bytes: number }>();

/** The build's index, from this isolate's memory when it read it before. */
async function loadSiteIndex(store: SiteStore, props: SiteAssetsProps): Promise<SiteIndex | null> {
  const id = `${backofficeScopePathSegment(props.scope)}${props.sitePath}@${props.build}`;
  const kept = indexes.get(id);
  if (kept) {
    // Map order is insertion order, so re-inserting marks it as the most recently used.
    indexes.delete(id);
    indexes.set(id, kept);
    return kept.index;
  }
  const index = await readSiteIndex(store, props.build);
  if (!index) {
    return null;
  }
  indexes.set(id, { index, bytes: JSON.stringify(index.files).length });
  let total = [...indexes.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [oldest, entry] of indexes) {
    if (total <= INDEXES_KEPT_BYTES || oldest === id) {
      break;
    }
    indexes.delete(oldest);
    total -= entry.bytes;
  }
  return index;
}

/**
 * Answers the site Worker's `env.ASSETS.fetch(request)` from the build: the file the path names,
 * `index.html` for a path ending in `/`, or 404, which the Worker may answer differently, such as
 * with `index.html` for a single-page app's routes.
 */
export async function serveSiteAssets({
  request,
  store,
  props,
}: {
  request: Request;
  store: SiteStore;
  props: SiteAssetsProps;
}): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const index = await loadSiteIndex(store, props);
  if (!index) {
    return new Response(`The build of ${props.sitePath} is incomplete; build it again.`, {
      status: 500,
    });
  }
  const url = new URL(request.url);
  const requested = url.pathname;
  let path: string;
  try {
    path = decodeURIComponent(requested);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const filePath = path.endsWith("/") ? `${path}index.html` : path;
  const file = Object.hasOwn(index.files, filePath) ? index.files[filePath] : null;
  if (!file) {
    // Relative links in a directory's index.html resolve against it only with the trailing slash.
    if (Object.hasOwn(index.files, `${path}/index.html`)) {
      return new Response(null, {
        status: 307,
        // The name as the request encoded it, so `#`, `?`, and names beyond ASCII stay in the
        // path, and after `./`, so a name with a colon does not read as a URL scheme. The query
        // stays, as the page may read it.
        headers: { location: `./${requested.split("/").at(-1)}/${url.search}` },
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  const etag = `"${file.etag}"`;
  const headers = new Headers({
    "content-type": file.contentType,
    etag,
    // A rebuild may change any file, so browsers revalidate rather than reuse a stale copy.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  const body = await store.readFile(props.build, siteObjectFile(filePath));
  if (body === null) {
    return new Response(`The build of ${props.sitePath} lacks ${filePath}; build it again.`, {
      status: 500,
    });
  }
  return new Response(body, { headers });
}
