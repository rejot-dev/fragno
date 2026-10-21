// artifacts tools
type ArtifactsCodemodeProvider = {
  /** Build a /workspace/**\/<name>.page.js page as Backoffice does when it is opened, without providers, and report its error. The build is cached for viewers. */
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
