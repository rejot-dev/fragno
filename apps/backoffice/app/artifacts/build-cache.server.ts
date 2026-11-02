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

/**
 * The cached outcome for these inputs, or null when the cache is missing, stale, or unreadable,
 * with when the cache was written, as `artifactBuildUpdatedAt` reports it.
 */
export async function readArtifactBuild(
  state: BackofficeStateBackend,
  sourcePath: string,
  key: string,
): Promise<{ outcome: ArtifactBuildOutcome | null; updatedAt: string | null }> {
  // Stated before reading: a build written between the two then reads as newer than this one,
  // never as the one read.
  const updatedAt = await artifactBuildUpdatedAt(state, sourcePath);
  if (updatedAt === null) {
    return { outcome: null, updatedAt };
  }
  let build: unknown;
  try {
    build = JSON.parse(await state.readFile(artifactBuildPath(sourcePath)));
  } catch {
    return { outcome: null, updatedAt };
  }
  return { outcome: cachedOutcome(build, key), updatedAt };
}

function cachedOutcome(build: unknown, key: string): ArtifactBuildOutcome | null {
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

/**
 * When a source's build was last written, as Upload records it, or null without one. A browser
 * compares it with the build's row in its replica to tell a newer build from the one it shows.
 */
export async function artifactBuildUpdatedAt(
  state: BackofficeStateBackend,
  sourcePath: string,
): Promise<string | null> {
  const stat = await state.stat(artifactBuildPath(sourcePath));
  return stat?.type === "file" ? stat.mtime.toISOString() : null;
}

/**
 * Caches an outcome, and returns when the cache was written; `state` writes with the system's
 * authority, since viewers may only read. Another build can land right after this one, so the
 * time is this build's only while the cache still holds it; otherwise it is null, which is older
 * than any build.
 */
export async function writeArtifactBuild(
  state: BackofficeStateBackend,
  sourcePath: string,
  key: string,
  outcome: ArtifactBuildOutcome,
): Promise<string | null> {
  const build: ArtifactBuildFile = { version: 1, key, outcome };
  const content = JSON.stringify(build, null, 2);
  await state.writeFile(artifactBuildPath(sourcePath), content);
  const updatedAt = await artifactBuildUpdatedAt(state, sourcePath);
  return (await state.readFile(artifactBuildPath(sourcePath))) === content ? updatedAt : null;
}
