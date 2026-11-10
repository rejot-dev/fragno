// Page and site builds and their errors. Read to verify a page after writing it, or to build a site.
type ArtifactsCodemodeProvider = {
  /**
   * Build a /workspace/**\/<name>.page.js page as Backoffice does when it is opened, without providers, and report its error. The build is cached for viewers.
   * Requires `upload.read`.
   */
  buildPage(input: ArtifactsBuildPageInput): Promise<ArtifactsBuildPageOutput>;
  /**
   * Build a /workspace/**\/<name>.site directory and serve the build in place of the previous one. worker.js default-exports { fetch(request, env) } and receives every request; env.ASSETS.fetch(request) answers with the file under public/ at the request's path, with index.html for a path ending in /. A site without worker.js serves its files. worker.js imports saved .js modules by path, not packages, and the Worker reaches no network. Building a site with worker.js also requires reading the scope's automation data: workflow.read, events.read, router.read, projects.read, store.read, connections.read, and pi.read.
   * Requires `upload.read` and `upload.modify`.
   */
  buildSite(input: ArtifactsBuildSiteInput): Promise<ArtifactsBuildSiteOutput>;
  /**
   * Report the copy of this scope's automation data that site Workers read with env.DATA.sql. Check it when a site answers 503 or shows old data: it tells whether sites can read the data yet, how far its first copy got, when it last applied a change, its last error, and when it retries.
   * Requires `upload.read`.
   */
  siteDataStatus(input: ArtifactsSiteDataStatusInput): Promise<ArtifactsSiteDataStatusOutput>;
  /**
   * Read what a site's Worker logged and threw, oldest first, for the latest requests that logged, threw, exceeded a limit, or answered 5xx. Read them after building a site and requesting it, and when a site fails or answers wrongly. Requests are kept for a day, the latest 200 per site.
   * Requires `upload.read` and `workflow.read` and `events.read` and `router.read` and `projects.read` and `store.read` and `connections.read` and `pi.read`.
   */
  siteLogs(input: ArtifactsSiteLogsInput): Promise<ArtifactsSiteLogsOutput>;
  /**
   * Request a built site as a viewer would, and return its answer with what its Worker logged and threw while answering. A site that does not answer within 15 seconds fails the request. Request the routes a site's pages call and its / after building it, before handing it to the user. The request reaches the site's latest build, reads the scope's data as the site does, and appears in the site's logs like any other.
   * Requires `upload.read` and `workflow.read` and `events.read` and `router.read` and `projects.read` and `store.read` and `connections.read` and `pi.read`.
   */
  requestSite(input: ArtifactsRequestSiteInput): Promise<ArtifactsRequestSiteOutput>;
};
declare const artifacts: ArtifactsCodemodeProvider;

type ArtifactsBuildPageInput = {
  path: string;
};
type ArtifactsBuildPageOutput =
  | {
      status: "built";
      path: string;
    }
  | {
      status: "failed";
      path: string;
      message: string;
    };
type ArtifactsBuildSiteInput = {
  path: string;
};
type ArtifactsBuildSiteOutput =
  | {
      status: "built";
      path: string;
      /** Where people open the site: its path at its scope's own subdomain of the sites domain, such as https://quiet-amber-falcon.ley.run/tools/shop.site/. Null where this deployment has no sites domain, so people cannot open its sites. */
      url: string | null;
    }
  | {
      status: "failed";
      path: string;
      message: string;
    };
type ArtifactsSiteDataStatusInput = Record<string, unknown>;
type ArtifactsSiteDataStatusOutput = {
  /** not-started: no site with a worker.js was built or read the data yet. catching-up: the first copy is in progress. caught-up: the copy held everything Automations had. failing: its last attempt to follow Automations failed; it retries at retryAt, and after a day of failures at the next read. */
  status: "not-started" | "catching-up" | "caught-up" | "failing";
  /** Whether sites can read the data; until the first catch-up ends they answer 503. */
  available: boolean;
  /** Whether the copy follows changes now. It follows them while sites read, and for a minute after; otherwise the next read finds it as it was, and it catches up then. */
  following: boolean;
  /** How much of the current catch-up was applied, from 0 to 1, while it runs. */
  progress: number | null;
  /** When the copy last applied a change. */
  lastAppliedAt: string | null;
  /** The copy's last error, kept after it recovers. */
  lastError: {
    message: string;
    at: string;
  } | null;
  /** When the copy next tries to catch up on its own. */
  retryAt: string | null;
  /** The size of the copy. */
  sizeBytes: number;
};
type ArtifactsSiteLogsInput = {
  path: string;
  /** Only requests from this time on, such as when the site was last built. */
  since?: string;
  /** Only requests that threw, exceeded a limit, answered 5xx, or logged an error. */
  errorsOnly?: boolean;
  /** How many of the latest requests to return, 50 unless given. */
  limit?: number;
};
type ArtifactsSiteLogsOutput = {
  entries: {
    /** When the request started. */
    at: string;
    method: string | null;
    /** The path within the site, with its query. */
    path: string | null;
    /** The response's status, or null when the Worker answered none. */
    status: number | null;
    /** ok, exception when the Worker threw, or the limit it exceeded, such as exceededCpu. */
    outcome: string;
    cpuMs: number | null;
    wallMs: number | null;
    logs: {
      level: string;
      message: string;
    }[];
    exceptions: {
      name: string;
      message: string;
      stack: string | null;
    }[];
  }[];
};
type ArtifactsRequestSiteInput = {
  path: string;
  /** The path within the site, with its query; / unless given. */
  url?: string;
  /** GET unless given. */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  headers?: {
    [key: string]: string;
  };
  body?: string;
  /** Who the Worker is told views the site, in ley-viewer-id and ley-viewer-email; nobody unless given. */
  viewer?: {
    id: string;
    email: string;
  };
};
type ArtifactsRequestSiteOutput = {
  /** The status a viewer gets: 500 when the Worker threw, and 503 while the scope's data is being copied. */
  status: number;
  headers: {
    [key: string]: string;
  };
  /** The body as text, its first 64 KB, when it is text, JSON, HTML, CSS, JavaScript, or SVG; otherwise its type and size. A body is read for at most 15 seconds, so a stream that stays open is cut there, with truncated true. Null when the Worker threw. */
  body:
    | {
        text: string;
        truncated: boolean;
      }
    | {
        omitted: {
          type: string | null;
          /** Null when the body is over 64 KB and its content-length is not given. */
          bytes: number | null;
        };
      }
    | null;
  /** Why the body broke off after the status and headers were sent, as a viewer gets it: body holds what arrived before, with truncated true. Null when the body ended, or was cut at its limit. */
  bodyError: string | null;
  /** What the Worker logged and threw while answering, with its outcome; null when the runtime had not reported the request within 5 seconds. */
  log: {
    /** When the request started. */
    at: string;
    method: string | null;
    /** The path within the site, with its query. */
    path: string | null;
    /** The response's status, or null when the Worker answered none. */
    status: number | null;
    /** ok, exception when the Worker threw, or the limit it exceeded, such as exceededCpu. */
    outcome: string;
    cpuMs: number | null;
    wallMs: number | null;
    logs: {
      level: string;
      message: string;
    }[];
    exceptions: {
      name: string;
      message: string;
      stack: string | null;
    }[];
  } | null;
};
