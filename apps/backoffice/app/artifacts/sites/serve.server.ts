import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

import {
  serveSiteAssets,
  siteStoreForServing,
  type SiteAssetsBinding,
  type SiteAssetsProps,
} from "./assets.server";
import { readSiteWorker } from "./site-build.server";
import type { SiteDataQuery } from "./site-data";
import type { SitePointerRead, SiteStore } from "./site-store.server";
import { siteWorkerCode } from "./site-worker.server";

/**
 * How long an isolate trusts a pointer it read: the requests of one page load share a read, and a
 * rebuild shows within this long.
 */
const POINTER_TRUSTED_MS = 1000;

/** The pointers an isolate read within `POINTER_TRUSTED_MS`, by site. */
export type SitePointerCache = {
  read(site: string, load: () => Promise<SitePointerRead>): Promise<SitePointerRead>;
};

export function createSitePointerCache(now: () => number): SitePointerCache {
  const pointers = new Map<string, { read: SitePointerRead; at: number }>();
  return {
    async read(site, load) {
      const kept = pointers.get(site);
      if (kept && now() - kept.at < POINTER_TRUSTED_MS) {
        return kept.read;
      }
      const read = await load();
      // Re-inserted, so the map stays in the order pointers were read and the expired lead it.
      pointers.delete(site);
      // Only a build is kept: a site that has none, or a broken pointer, shows its fix at once.
      if (read.status === "built") {
        pointers.set(site, { read, at: now() });
      }
      for (const [expired, entry] of pointers) {
        if (now() - entry.at < POINTER_TRUSTED_MS) {
          break;
        }
        pointers.delete(expired);
      }
      return read;
    },
  };
}

/** The bindings the host gives a site's Worker, each bound to the props the host sets. */
export type SiteWorkerBindings = {
  workerLoader: WorkerLoader | null;
  siteAssets: (props: SiteAssetsProps) => SiteAssetsBinding;
  /** The site Worker's `env.DATA`, which reads the scope's automation data. */
  siteData: (scope: BackofficeContextScope) => unknown;
};

/** The Worker entrypoints that bind a site's Worker, which a Worker exports to bind it. */
type SiteWorkerExports = {
  SiteAssets(options: { props: SiteAssetsProps }): Fetcher;
  SiteData(options: { props: { scope: BackofficeContextScope } }): Fetcher;
};

/** A site's bindings, from the `ctx.exports` of a Worker that exports their entrypoints. */
export function exportedSiteWorkerBindings(
  workerLoader: WorkerLoader | null,
  exports: unknown,
): SiteWorkerBindings {
  // Generated types describe the objects Worker's exports; this Worker's entry exports these.
  const site = exports as SiteWorkerExports;
  return {
    workerLoader,
    siteAssets: (props) => site.SiteAssets({ props }),
    siteData: (scope) => site.SiteData({ props: { scope } }),
  };
}

/** A site's bindings served in this process, for runtimes whose objects run in it too. */
export function inProcessSiteWorkerBindings(
  runtime: BackofficeRuntimeServices,
): SiteWorkerBindings {
  return {
    workerLoader: runtime.workerLoader,
    siteAssets: (props) => ({
      fetch: async (request) =>
        await serveSiteAssets({
          request,
          store: siteStoreForServing({ ...props, runtime, cache: null }),
          props,
        }),
    }),
    siteData: (scope) => ({
      query: async (query: SiteDataQuery) =>
        await runtime.objects.siteReplica.for(scope).commands.query(scope, query),
    }),
  };
}

/**
 * Answers a request to a site with its Worker, from the build its pointer names; the Worker reads
 * its files through `env.ASSETS`, which `siteAssets` binds to the build, and the scope's data
 * through `env.DATA`. `pathname` is the site-relative path as the request spelled it, such as `/`
 * or `/api/orders`.
 */
export async function serveSite({
  request,
  store,
  pointers,
  bindings: { workerLoader, siteAssets, siteData },
  scope,
  sitePath,
  pathname,
}: {
  request: Request;
  store: SiteStore;
  pointers: SitePointerCache;
  bindings: SiteWorkerBindings;
  scope: BackofficeContextScope;
  sitePath: string;
  pathname: string;
}): Promise<Response> {
  const site = `${backofficeContextScopeRoutePath(scope)}${sitePath}`;
  const read = await pointers.read(site, () => store.readPointer());
  if (read.status === "none") {
    return new Response(`${sitePath} has not been built.`, { status: 404 });
  }
  if (read.status === "unreadable") {
    return new Response(`${read.message}\nBuild ${sitePath} again to replace it.`, {
      status: 500,
    });
  }
  if (!workerLoader) {
    return new Response("This Backoffice runtime cannot run site Workers.", { status: 501 });
  }
  const props: SiteAssetsProps = { scope, sitePath, build: read.pointer.served.build };
  // The name includes the build, so an isolate stays warm until the site is rebuilt, and the
  // Worker's code is read only when an isolate starts.
  const worker = workerLoader.get(`site:${site}@${props.build}`, async () => {
    const built = await readSiteWorker(store, props.build);
    if (!built) {
      throw new Error(`The build of ${sitePath} is incomplete; build it again.`);
    }
    return siteWorkerCode(built.bundle, { ASSETS: siteAssets(props), DATA: siteData(scope) });
  });
  return withoutSetCookie(await worker.getEntrypoint().fetch(siteWorkerRequest(request, pathname)));
}

/** The request as the Worker sees it: at its site-relative path, without the viewer's session. */
function siteWorkerRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** Sites share the Backoffice origin until they have their own, so they cannot set its cookies. */
function withoutSetCookie(response: Response): Response {
  if (!response.headers.has("set-cookie")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
