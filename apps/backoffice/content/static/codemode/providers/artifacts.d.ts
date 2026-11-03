// Page and site builds and their errors. Read to verify a page after writing it, or to build a site.
type ArtifactsCodemodeProvider = {
  /**
   * Build a /workspace/**\/<name>.page.js page as Backoffice does when it is opened, without providers, and report its error. The build is cached for viewers.
   * Requires `upload.read`.
   */
  buildPage(input: ArtifactsBuildPageInput): Promise<ArtifactsBuildPageOutput>;
  /**
   * Build a /workspace/**\/<name>.site directory and serve the build in place of the previous one. worker.js default-exports { fetch(request, env) } and receives every request; env.ASSETS.fetch(request) answers with the file under public/ at the request's path, with index.html for a path ending in /. A site without worker.js serves its files. worker.js imports saved .js modules by path, not packages, and the Worker reaches no network.
   * Requires `upload.read` and `upload.modify`.
   */
  buildSite(input: ArtifactsBuildSiteInput): Promise<ArtifactsBuildSiteOutput>;
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
