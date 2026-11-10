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
import type { SiteDataProps, SiteDataQuery, SiteProbe } from "./site-data";
import type { SiteEvent } from "./site-events";
import { fireSiteEvent } from "./site-events.server";
import { recordSiteTraces, type SiteTailProps, type SiteTraceItem } from "./site-logs";
import { SITE_HOST_COOKIE_PREFIX, type SiteViewer } from "./site-session.server";
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
  /** The site Worker's `env.DATA`, which reads the scope's automation data and fires events. */
  siteData: (props: SiteDataProps) => unknown;
  /** The tail that keeps what the site's Worker logs and throws in the scope's site logs. */
  siteTail: (props: SiteTailProps) => unknown;
};

/** The Worker entrypoints that bind a site's Worker, which a Worker exports to bind it. */
type SiteWorkerExports = {
  SiteAssets(options: { props: SiteAssetsProps }): Fetcher;
  SiteData(options: { props: SiteDataProps }): Fetcher;
  SiteTail(options: { props: SiteTailProps }): Fetcher;
};

/** A site's bindings, from the `ctx.exports` of a Worker that exports their entrypoints. */
export function exportedSiteWorkerBindings(
  workerLoader: WorkerLoader | null,
  exports: unknown,
): SiteWorkerBindings {
  // Generated types describe one Worker's exports; both Workers export these.
  const site = exports as SiteWorkerExports;
  return {
    workerLoader,
    siteAssets: (props) => site.SiteAssets({ props }),
    siteData: (props) => site.SiteData({ props }),
    siteTail: (props) => site.SiteTail({ props }),
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
    siteData: (props) => ({
      query: async (query: SiteDataQuery) =>
        await runtime.objects.siteReplica.for(props.scope).commands.query(props.scope, query),
      fire: async (event: SiteEvent) =>
        await fireSiteEvent({
          objects: runtime.objects,
          limiter: runtime.siteEventLimiter,
          props,
          event,
        }),
    }),
    siteTail: (props) => ({
      tail: async (events: SiteTraceItem[]) => {
        await recordSiteTraces(
          events,
          props,
          runtime.objects.siteRequests.for(props.scope).commands,
        );
      },
    }),
  };
}

/** A site's Worker for a request, or the host's own answer when the site has none to run. */
export type SiteWorkerLoad =
  | { kind: "worker"; worker: WorkerStub }
  | { kind: "answered"; response: Response };

/**
 * Loads a site's Worker from the build its pointer names; the Worker reads its files through
 * `env.ASSETS`, which `siteAssets` binds to the build. A `probe` loads a Worker of its own, for the
 * one request an agent sends, whose tail hands that request's record to the agent, and whose
 * events are kept for the agent, and fired only when the agent asked.
 */
export async function loadSiteWorker({
  store,
  pointers,
  bindings: { workerLoader, siteAssets, siteData, siteTail },
  scope,
  sitePath,
  probe,
}: {
  store: SiteStore;
  pointers: SitePointerCache;
  bindings: SiteWorkerBindings;
  scope: BackofficeContextScope;
  sitePath: string;
  probe?: SiteProbe;
}): Promise<SiteWorkerLoad> {
  const site = `${backofficeContextScopeRoutePath(scope)}${sitePath}`;
  const read = await pointers.read(site, () => store.readPointer());
  if (read.status === "none") {
    return answered(`${sitePath} has not been built.`, 404);
  }
  if (read.status === "unreadable") {
    return answered(`${read.message}\nBuild ${sitePath} again to replace it.`, 500);
  }
  if (!workerLoader) {
    return answered("This Backoffice runtime cannot run site Workers.", 501);
  }
  const props: SiteAssetsProps = { scope, sitePath, build: read.pointer.served.build };
  // The name includes the build, so an isolate stays warm until the site is rebuilt, and the
  // Worker's code is read only when an isolate starts.
  const name = `${probe ? `probe:${probe.id}:` : ""}site:${site}@${props.build}`;
  const worker = workerLoader.get(name, async () => {
    const built = await readSiteWorker(store, props.build);
    if (!built) {
      throw new Error(`The build of ${sitePath} is incomplete; build it again.`);
    }
    return siteWorkerCode(
      built.bundle,
      {
        ASSETS: siteAssets(props),
        DATA: siteData({ scope, sitePath, fires: built.fires, ...(probe ? { probe } : {}) }),
      },
      [siteTail({ scope, sitePath, ...(probe ? { probe: probe.id } : {}) }) as Fetcher],
    );
  });
  return { kind: "worker", worker };
}

/**
 * Loads a site's Worker for the one request an agent sends, as `probe`. Its pointer is read afresh,
 * so a request sent right after a build reaches that build, and its files are read uncached.
 */
export async function loadProbedSiteWorker({
  runtime,
  bindings,
  scope,
  sitePath,
  probe,
}: {
  runtime: BackofficeRuntimeServices;
  bindings: SiteWorkerBindings;
  scope: BackofficeContextScope;
  sitePath: string;
  probe: SiteProbe;
}): Promise<SiteWorkerLoad> {
  return await loadSiteWorker({
    store: siteStoreForServing({ runtime, scope, sitePath, cache: null }),
    pointers: { read: async (_site, load) => await load() },
    bindings,
    scope,
    sitePath,
    probe,
  });
}

/** Headers that tell a site's Worker who is viewing it; only the host sets them. */
export const SITE_VIEWER_HEADERS = { id: "ley-viewer-id", email: "ley-viewer-email" } as const;

/**
 * Answers a request to a site with its Worker. `pathname` is the site-relative path as the
 * request spelled it, such as `/` or `/api/orders`.
 */
export async function serveSite({
  request,
  pathname,
  viewer,
  ...site
}: Parameters<typeof loadSiteWorker>[0] & {
  request: Request;
  pathname: string;
  viewer: SiteViewer | null;
}): Promise<Response> {
  const loaded = await loadSiteWorker(site);
  if (loaded.kind === "answered") {
    return loaded.response;
  }
  return await fetchSiteWorker(loaded.worker, request, pathname, viewer);
}

/**
 * A site Worker's answer to a request, as a viewer receives it. `viewer` is who the host signed
 * in, or who an agent's probe says views the site; null for nobody.
 */
export async function fetchSiteWorker(
  worker: WorkerStub,
  request: Request,
  pathname: string,
  viewer: SiteViewer | null,
): Promise<Response> {
  const response = await worker.getEntrypoint().fetch(siteWorkerRequest(request, pathname, viewer));
  return withoutHostCookies(response);
}

function answered(message: string, status: number): SiteWorkerLoad {
  return { kind: "answered", response: new Response(message, { status }) };
}

/**
 * The request as the Worker sees it: at its site-relative path, with its own cookies but not the
 * host's, and with who the host says is viewing, whatever the request claimed.
 */
function siteWorkerRequest(request: Request, pathname: string, viewer: SiteViewer | null): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  const headers = new Headers(request.headers);
  const cookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie !== "" && !cookie.startsWith(SITE_HOST_COOKIE_PREFIX));
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  } else {
    headers.delete("cookie");
  }
  // A browser or a probe could send these too; only the host's are true.
  for (const name of [...headers.keys()].filter((key) => key.startsWith("ley-"))) {
    headers.delete(name);
  }
  if (viewer) {
    headers.set(SITE_VIEWER_HEADERS.id, viewer.id);
    headers.set(SITE_VIEWER_HEADERS.email, viewer.email);
  }
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/**
 * On its own host a site sets its own cookies, but not the host's session, and not for the whole
 * sites domain, where they would reach the other scopes' sites.
 */
function withoutHostCookies(response: Response): Response {
  const cookies = response.headers.getSetCookie();
  const kept = cookies.filter(
    (cookie) =>
      !cookie.trimStart().toLowerCase().startsWith(SITE_HOST_COOKIE_PREFIX.toLowerCase()) &&
      !/;\s*domain\s*=/iu.test(cookie),
  );
  if (kept.length === cookies.length) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of kept) {
    headers.append("set-cookie", cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
