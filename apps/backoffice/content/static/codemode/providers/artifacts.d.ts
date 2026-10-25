// Page builds and their errors. Read to verify a page after writing it.
type ArtifactsCodemodeProvider = {
  /**
   * Build a /workspace/**\/<name>.page.js page as Backoffice does when it is opened, without providers, and report its error. The build is cached for viewers.
   * Requires `upload.read`.
   */
  buildPage(input: ArtifactsBuildPageInput): Promise<ArtifactsBuildPageOutput>;
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
