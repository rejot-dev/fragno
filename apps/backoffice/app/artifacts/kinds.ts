/** What Backoffice opens from a workspace file, by the suffix its path ends with. */
const ARTIFACT_SUFFIXES = {
  page: ".page.js",
  workflow: ".workflow.js",
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_SUFFIXES;

export function artifactKind(path: string): ArtifactKind | null {
  const lowerPath = path.toLowerCase();
  const kind = (Object.keys(ARTIFACT_SUFFIXES) as ArtifactKind[]).find((candidate) =>
    lowerPath.endsWith(ARTIFACT_SUFFIXES[candidate]),
  );
  return kind ?? null;
}

/** The path without its kind's suffix, such as `reports/operations` for a page. */
export function artifactName(path: string, kind: ArtifactKind): string {
  return path.slice(0, -ARTIFACT_SUFFIXES[kind].length);
}

export function artifactSourcePath(name: string, kind: ArtifactKind): string {
  return `${name}${ARTIFACT_SUFFIXES[kind]}`;
}
