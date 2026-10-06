import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { z } from "zod";

import type { Context } from "@earendil-works/chord";
import { createRegistry, type Extension, type RegistrySnapshot } from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { runBackofficeCompiledModule } from "@/fragno/codemode/compiled-module-execute";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import {
  javaScriptModuleArtifactSchema,
  resolveJavaScriptModuleArtifactPath,
} from "@/fragno/codemode/javascript-module-artifact";

import type { PiRuntimeToolContext } from "./pi-runtime-context";
import { createPiWorkspaceExtensionBridge } from "./pi-workspace-extension-bridge";
import { piWorkspaceExtensionMetadataSchema } from "./pi-workspace-extension-metadata";
import { createPiWorkspaceExtensionInvocation } from "./pi-workspace-extension-source";

const PI_WORKSPACE_EXTENSION_MANIFEST = "/workspace/pi/extensions.json";
const extensionFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);

type WorkspaceExtensionLoaderInput = {
  execution: BackofficeExecutionContext;
  createRuntimeToolContext: (context: Context, invocationId: string) => PiRuntimeToolContext;
  env: BackofficeCodemodeEnv | null;
  registry: RegistrySnapshot;
  authorizeExecution: () => Promise<void>;
  report: (error: unknown) => void;
};

/** Loads activated artifacts and validates native proxies before a session can install them. */
export async function loadPiWorkspaceExtensions(
  input: WorkspaceExtensionLoaderInput,
): Promise<Extension[]> {
  if (input.execution.scope.kind === "system") {
    return [];
  }
  const runtimeToolContext = input.createRuntimeToolContext(
    BACKGROUND_CONTEXT,
    "workspace-extension-load",
  );
  if (!runtimeToolContext.stateBackend) {
    return [];
  }
  const state = runtimeToolContext.stateBackend;
  const installed: Extension[] = [];
  const names = new Set(input.registry.installed().map((extension) => extension.name));
  const keys = new Set([
    "backoffice",
    ...input.registry.sections().map(({ section }) => section.key),
  ]);
  const tools = new Set(input.registry.tools().map(({ tool }) => tool.name));
  const validationRegistry = createRegistry();
  let prepared: { paths: string[]; env: BackofficeCodemodeEnv };
  try {
    await input.authorizeExecution();
    if (!(await state.exists(PI_WORKSPACE_EXTENSION_MANIFEST))) {
      return [];
    }
    if (input.env === null) {
      throw new Error("PI_EXTENSION_CODEMODE_UNAVAILABLE");
    }
    const manifest = z
      .strictObject({ extensions: z.array(extensionFilePathSchema).max(16) })
      .parse(await state.readJson(PI_WORKSPACE_EXTENSION_MANIFEST));
    const paths = manifest.extensions.map((path) => {
      if (path.endsWith(".js")) {
        throw new Error(
          `PI_EXTENSION_BUILD_REQUIRED: build ${path} with js.build and activate its artifact.`,
        );
      }
      try {
        return resolveJavaScriptModuleArtifactPath(path, state, "/workspace/pi");
      } catch (error) {
        throw new Error(`PI_EXTENSION_INVALID_PATH: ${path}`, { cause: error });
      }
    });
    if (new Set(paths).size !== paths.length) {
      throw new Error("PI_EXTENSION_DUPLICATE_PATH");
    }
    prepared = { paths, env: input.env };
  } catch (error) {
    input.report(
      new Error(`PI_EXTENSION_LOAD_FAILED: ${PI_WORKSPACE_EXTENSION_MANIFEST}`, { cause: error }),
    );
    return [];
  }
  const { env, paths } = prepared;
  const invocation = createPiWorkspaceExtensionInvocation([]);
  for (const path of paths) {
    try {
      const file = await state.stat(path);
      if (file?.type !== "file") {
        throw new Error(`PI_EXTENSION_BUILD_REQUIRED: missing ${path}; create it with js.build.`);
      }
      if (file.size > CODEMODE_LIMITS.maxBundleBytes) {
        throw new Error("PI_EXTENSION_ARTIFACT_TOO_LARGE");
      }
      let artifact: z.infer<typeof javaScriptModuleArtifactSchema>;
      try {
        artifact = javaScriptModuleArtifactSchema.parse(await state.readJson(path));
      } catch (error) {
        throw new Error(`PI_EXTENSION_ARTIFACT_INVALID: rebuild ${path} with js.build.`, {
          cause: error,
        });
      }
      const metadata = piWorkspaceExtensionMetadataSchema.parse(
        await runBackofficeCompiledModule({
          bundle: artifact.bundle,
          invocation,
          input: { operation: "inspect" },
          providers: [],
          env,
          signal: null,
        }),
      );
      if (names.has(metadata.name)) {
        throw new Error(`PI_EXTENSION_DUPLICATE_NAME: ${metadata.name}`);
      }
      for (const { key } of metadata.sections) {
        if (keys.has(key)) {
          throw new Error(`PI_EXTENSION_DUPLICATE_SECTION: ${key}`);
        }
      }
      for (const { name } of metadata.tools) {
        if (tools.has(name)) {
          throw new Error(`PI_EXTENSION_DUPLICATE_TOOL: ${name}`);
        }
      }
      const extension = createPiWorkspaceExtensionBridge({
        ...input,
        metadata,
        bundle: artifact.bundle,
        path,
        env,
      });
      // Reuse native registration rules inside per-artifact recovery, before the real host installation.
      validationRegistry.install(extension);
      installed.push(extension);
      names.add(metadata.name);
      for (const { key } of metadata.sections) {
        keys.add(key);
      }
      for (const { name } of metadata.tools) {
        tools.add(name);
      }
    } catch (error) {
      input.report(new Error(`PI_EXTENSION_LOAD_FAILED: ${path}`, { cause: error }));
    }
  }
  return installed;
}
