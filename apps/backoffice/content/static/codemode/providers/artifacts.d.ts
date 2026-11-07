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
