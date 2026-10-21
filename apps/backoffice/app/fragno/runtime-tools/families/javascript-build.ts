import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  builtJavaScriptModuleSchema,
  resolveBuiltJavaScriptModulePath,
} from "@/fragno/codemode/built-javascript-module";
import type { CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import { buildBackofficeJavaScriptModule } from "@/fragno/codemode/compiled-module-execute";
import { readSavedModuleImports } from "@/fragno/codemode/saved-module-imports";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type { JavaScriptBuildFileOutput } from "@/fragno/runtime-tools/families/javascript-runtime";

import { dependencies } from "../../../../package.json";

/**
 * Builds one saved ES module without running it; a failed compilation preserves the previous
 * built module. Throws when the input is refused before a build run is recorded.
 */
export async function buildJavaScriptModuleFile(input: {
  path: string;
  out: string;
  state: BackofficeStateBackend;
  codemode: CodemodeRunner;
}): Promise<JavaScriptBuildFileOutput> {
  if (
    !input.path.startsWith("/") ||
    input.path.split("/").includes("..") ||
    /\p{Cc}/u.test(input.path) ||
    input.path.length > 512
  ) {
    throw new BackofficeOperationError(
      "invalid_request",
      `JAVASCRIPT_BUILD_INVALID_SOURCE_PATH: ${input.path}`,
    );
  }
  const path = input.state.resolvePath("/workspace", input.path);
  if ((!path.startsWith("/workspace/") && !path.startsWith("/static/")) || !path.endsWith(".js")) {
    throw new BackofficeOperationError(
      "invalid_request",
      `JAVASCRIPT_BUILD_INVALID_SOURCE_PATH: ${input.path}`,
    );
  }
  if (!input.out.startsWith("/")) {
    throw new Error("JAVASCRIPT_BUILD_INVALID_OUTPUT_PATH: build output must be absolute.");
  }
  const outputPath = resolveBuiltJavaScriptModulePath(input.out, input.state, "/workspace");
  const source = await input.state.stat(path);
  if (source?.type !== "file") {
    throw new BackofficeOperationError("not_found", `JAVASCRIPT_BUILD_SOURCE_MISSING: ${path}`);
  }
  if (source.size > CODEMODE_LIMITS.maxSourceBytes) {
    throw new Error("CODEMODE_SOURCE_LIMIT_EXCEEDED");
  }
  const { modules } = await readSavedModuleImports({
    readFile: (modulePath) => input.state.readFile(modulePath),
    program: { kind: "file", path },
  });
  const built = await buildBackofficeJavaScriptModule({
    entry: path,
    modules,
    dependencies: { "@earendil-works/pi-durable": dependencies["@earendil-works/pi-durable"] },
    codemode: input.codemode,
  });
  const { runId } = built;
  if (built.status === "error") {
    return { status: "error", path, outputPath, runId, error: built.error };
  }
  const builtModule = JSON.stringify({
    format: builtJavaScriptModuleSchema.shape.format.value,
    bundle: built.bundle,
  });
  if (new TextEncoder().encode(builtModule).byteLength > CODEMODE_LIMITS.maxBundleBytes) {
    return {
      status: "error",
      path,
      outputPath,
      runId,
      error: "JAVASCRIPT_BUILD_OUTPUT_TOO_LARGE",
    };
  }
  try {
    // Upload publishes a complete file revision atomically; consumers never see partial build output.
    await input.state.writeFile(outputPath, builtModule);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", path, outputPath, runId, error: message };
  }
  return { status: "success", path, outputPath, runId, warnings: built.warnings };
}
