import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

const WORKSPACE = "/workspace/";
const BUILD_DIRECTORY = "/workspace/.build/";

/** A failed build is cached too, so a broken source shows its error without rebuilding. */
export type ArtifactBuildOutcome =
  | { kind: "built"; output: JsonValue }
  | { kind: "failed"; message: string };

type ArtifactBuildFile = { version: 1; key: string; outcome: ArtifactBuildOutcome };

/**
 * Where the system caches a source's build: the source's workspace path under `.build`, as JSON,
 * such as `/workspace/.build/reports/operations.page.json`. Deleting it only forces a rebuild.
 */
export function artifactBuildPath(sourcePath: string): string {
  if (!sourcePath.startsWith(WORKSPACE)) {
    throw new Error(`Artifacts are built from workspace sources, not ${sourcePath}.`);
  }
  return `${BUILD_DIRECTORY}${sourcePath.slice(WORKSPACE.length).replace(/\.js$/u, "")}.json`;
}

/** Names a build's inputs: the program that builds the source, and every module it imports. */
export async function artifactBuildKey(
  program: string,
  modules: Record<string, string>,
): Promise<string> {
  const inputs = JSON.stringify([
    program,
    Object.entries(modules).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inputs));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The cached outcome for these inputs, or null when the cache is missing, stale, or unreadable. */
export async function readArtifactBuild(
  state: BackofficeStateBackend,
  sourcePath: string,
  key: string,
): Promise<ArtifactBuildOutcome | null> {
  const path = artifactBuildPath(sourcePath);
  if ((await state.stat(path))?.type !== "file") {
    return null;
  }
  let build: unknown;
  try {
    build = JSON.parse(await state.readFile(path));
  } catch {
    return null;
  }
  if (build === null || typeof build !== "object" || !("key" in build) || build.key !== key) {
    return null;
  }
  const outcome = "outcome" in build ? build.outcome : null;
  if (outcome === null || typeof outcome !== "object" || !("kind" in outcome)) {
    return null;
  }
  if (outcome.kind === "failed" && "message" in outcome && typeof outcome.message === "string") {
    return { kind: "failed", message: outcome.message };
  }
  // The file holds JSON, so its output is JSON; the caller validates what it means.
  return outcome.kind === "built" && "output" in outcome
    ? { kind: "built", output: outcome.output as JsonValue }
    : null;
}

/** Caches an outcome; `state` writes with the system's authority, since viewers may only read. */
export async function writeArtifactBuild(
  state: BackofficeStateBackend,
  sourcePath: string,
  key: string,
  outcome: ArtifactBuildOutcome,
): Promise<void> {
  const build: ArtifactBuildFile = { version: 1, key, outcome };
  await state.writeJson(artifactBuildPath(sourcePath), build, { spaces: 2 });
}
