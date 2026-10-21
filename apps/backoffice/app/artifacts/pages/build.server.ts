import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";

import {
  artifactBuildKey,
  readArtifactBuild,
  writeArtifactBuild,
  type ArtifactBuildOutcome,
} from "@/artifacts/build-cache.server";
import {
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { withBackofficeUiBuilder } from "@/backoffice-ui/builder";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import {
  readSavedModuleImports,
  SavedModuleImportError,
} from "@/fragno/codemode/saved-module-imports";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { parsePageDefinition, type PageLoad } from "./definition";

const BUILD_TIMEOUT_MS = 10_000;

/**
 * Loads a page from its source, building it only when the source, a module it imports, or the
 * builders changed since the cached build. The build runs without providers, so a source can only
 * describe a page, never act with the viewer's authority.
 */
export async function loadPage({
  runtime,
  kernel,
  execution,
  sourcePath,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  sourcePath: string;
}): Promise<PageLoad> {
  const viewer = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime,
    kernel,
    execution,
  });
  const state = viewer.stateBackend;
  if ((await state.stat(sourcePath))?.type !== "file") {
    return { kind: "missing" };
  }

  const code = pageBuildProgram(sourcePath);
  const imports = await readPageImports(sourcePath, (path) => state.readFile(path));
  if (imports.kind === "failed") {
    return imports;
  }
  const { modules } = imports;
  const key = await artifactBuildKey(withBackofficeUiBuilder(code), modules);
  const cached = await readArtifactBuild(state, sourcePath, key);
  if (cached?.kind === "failed") {
    return cached;
  }
  // A current build that no longer validates was edited by hand, so it is rebuilt.
  const cachedDefinition = cached ? parsePageDefinition(cached.output) : null;
  if (cachedDefinition?.kind === "valid") {
    return { kind: "ready", definition: cachedDefinition.definition };
  }

  const run = await runBackofficeCodemode({
    code,
    codemode: codemodeRunnerFor(
      kernel.scoped("CODEMODE", execution.scope, runtime.objects.codemode).commands,
      execution,
    ),
    timeout: BUILD_TIMEOUT_MS,
    toolContext: createBackofficeToolContext(viewer),
    families: [],
  });
  // Errors the source causes come back as its result, so a run error is the system's: an outage,
  // a limit, or a timeout. Caching it would keep the page broken after the system recovers.
  if (run.error !== undefined) {
    return { kind: "failed", message: `The page could not be built right now: ${run.error}` };
  }
  const outcome = buildOutcome(run.result);
  const system = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime,
    kernel,
    execution: createBackofficeSystemExecution(execution.scope),
  });
  await writeArtifactBuild(system.stateBackend, sourcePath, key, outcome);
  return loadOutcome(outcome);
}

/**
 * Imports the source and reports what it throws as its result. Builder errors, errors the
 * source throws, and a missing default export then arrive as results, never as run errors.
 */
function pageBuildProgram(sourcePath: string): string {
  return `async () => {
  try {
    return { ok: true, definition: (await import(${JSON.stringify(sourcePath)})).default };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}`;
}

/** The saved modules a page imports; an import the build cannot load is the source's error. */
async function readPageImports(
  sourcePath: string,
  readFile: (path: string) => Promise<string>,
): Promise<
  { kind: "read"; modules: Record<string, string> } | { kind: "failed"; message: string }
> {
  try {
    const { modules, packages } = await readSavedModuleImports({
      readFile,
      program: { kind: "file", path: sourcePath },
    });
    if (packages.length > 0) {
      return {
        kind: "failed",
        message: `Pages import saved modules by path, not packages (${packages.join(", ")}).`,
      };
    }
    return { kind: "read", modules };
  } catch (error) {
    if (!(error instanceof SavedModuleImportError)) {
      throw error;
    }
    return {
      kind: "failed",
      message: `${error.path ?? sourcePath}:${error.line}:${error.column}: ${error.message}`,
    };
  }
}

/** The source's own failures and invalid definitions are cached, so they are not rebuilt on every view. */
function buildOutcome(result: unknown): ArtifactBuildOutcome {
  // The build program returns one of its two shapes.
  const built = result as { ok: true; definition: unknown } | { ok: false; message: string };
  if (!built.ok) {
    return { kind: "failed", message: built.message };
  }
  const parsed = parsePageDefinition(built.definition);
  return parsed.kind === "valid"
    ? // Codemode results cross the guest boundary as JSON.
      { kind: "built", output: built.definition as JsonValue }
    : { kind: "failed", message: parsed.message };
}

function loadOutcome(outcome: ArtifactBuildOutcome): PageLoad {
  if (outcome.kind === "failed") {
    return outcome;
  }
  const parsed = parsePageDefinition(outcome.output);
  return parsed.kind === "valid"
    ? { kind: "ready", definition: parsed.definition }
    : { kind: "failed", message: parsed.message };
}
