import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";

import { buildBackofficeJavaScriptModule } from "@/fragno/codemode/compiled-module-execute";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import {
  javaScriptModuleArtifactSchema,
  resolveJavaScriptModuleArtifactPath,
} from "@/fragno/codemode/javascript-module-artifact";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import { dependencies } from "../../../../package.json";

/** Builds one saved ES module without running it; a failed compilation preserves the previous artifact. */
export async function buildJavaScriptModuleFile(input: {
  path: string;
  out: string;
  state: BackofficeStateBackend;
  env: BackofficeCodemodeEnv;
}): Promise<{ path: string; artifactPath: string; warnings: string[] }> {
  if (
    !input.path.startsWith("/") ||
    input.path.split("/").includes("..") ||
    /\p{Cc}/u.test(input.path) ||
    input.path.length > 512
  ) {
    throw new Error(`JAVASCRIPT_BUILD_INVALID_SOURCE_PATH: ${input.path}`);
  }
  const path = input.state.resolvePath("/workspace", input.path);
  if ((!path.startsWith("/workspace/") && !path.startsWith("/static/")) || !path.endsWith(".js")) {
    throw new Error(`JAVASCRIPT_BUILD_INVALID_SOURCE_PATH: ${input.path}`);
  }
  if (!input.out.startsWith("/")) {
    throw new Error("JAVASCRIPT_BUILD_INVALID_OUTPUT_PATH: build output must be absolute.");
  }
  const artifactPath = resolveJavaScriptModuleArtifactPath(input.out, input.state, "/workspace");
  const source = await input.state.stat(path);
  if (source?.type !== "file") {
    throw new Error(`JAVASCRIPT_BUILD_SOURCE_MISSING: ${path}`);
  }
  if (source.size > CODEMODE_LIMITS.maxSourceBytes) {
    throw new Error("CODEMODE_SOURCE_LIMIT_EXCEEDED");
  }
  const compiled = await buildBackofficeJavaScriptModule({
    code: await input.state.readFile(path),
    dependencies: { "@earendil-works/pi-durable": dependencies["@earendil-works/pi-durable"] },
    env: input.env,
  });
  const artifact = JSON.stringify({
    format: javaScriptModuleArtifactSchema.shape.format.value,
    bundle: compiled.bundle,
  });
  if (new TextEncoder().encode(artifact).byteLength > CODEMODE_LIMITS.maxBundleBytes) {
    throw new Error("JAVASCRIPT_BUILD_ARTIFACT_TOO_LARGE");
  }
  // Upload publishes a complete file revision atomically; consumers never see partial build output.
  await input.state.writeFile(artifactPath, artifact);
  return { path, artifactPath, warnings: compiled.warnings };
}
