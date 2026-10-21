import { codemodeWorkerBundleSchema } from "@fragno-dev/codemode/execution/codemode-worker-bundle";
import { z } from "zod";

import type { BackofficeStateBackend } from "./state-backend";

/** A compiled JavaScript module stores code only; consumers own export contracts and capabilities. */
export const builtJavaScriptModuleSchema = z.strictObject({
  format: z.literal("fragno-javascript-module/v1"),
  bundle: codemodeWorkerBundleSchema,
});

/** Build outputs stay inside the current workspace. */
export function resolveBuiltJavaScriptModulePath(
  path: string,
  state: Pick<BackofficeStateBackend, "resolvePath">,
  basePath: string,
): string {
  if (path.split("/").includes("..") || /\p{Cc}/u.test(path) || path.length > 512) {
    throw new Error(`JAVASCRIPT_BUILD_INVALID_OUTPUT_PATH: ${path}`);
  }
  const absolutePath = state.resolvePath(basePath, path);
  if (!absolutePath.startsWith("/workspace/") || !absolutePath.endsWith(".json")) {
    throw new Error(`JAVASCRIPT_BUILD_INVALID_OUTPUT_PATH: ${path}`);
  }
  return absolutePath;
}
