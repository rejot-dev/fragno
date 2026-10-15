import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { z } from "zod";

import { createRegistry, type Extension, type RegistrySnapshot } from "@earendil-works/pi-durable";

import type { CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCompiledModule } from "@/fragno/codemode/compiled-module-execute";
import {
  javaScriptModuleArtifactSchema,
  resolveJavaScriptModuleArtifactPath,
} from "@/fragno/codemode/javascript-module-artifact";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type {
  BackofficeAgentContext,
  BackofficeAgentTurnContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

import { createPiWorkspaceExtensionBridge } from "./workspace-extension-bridge";
import { createPiWorkspaceExtensionInvocation } from "./workspace-extension-guest";
import { piWorkspaceExtensionMetadataSchema } from "./workspace-extension-metadata";

const PI_WORKSPACE_EXTENSION_MANIFEST = "/workspace/pi/extensions.json";
const extensionFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);

export type LoadedWorkspaceExtensions = {
  /** Identifies the manifest and artifacts the extensions were loaded from. */
  fingerprint: string;
  extensions: readonly Extension[];
};

/**
 * Loads activated artifacts and validates native proxies before an agent can install them.
 * Returns null when the manifest and its artifacts are unchanged since `loaded`.
 */
export async function loadWorkspaceExtensions(input: {
  agent: BackofficeAgentContext;
  /** The turn the extensions load for; it may not be admitted yet. */
  turn: BackofficeAgentTurnContext;
  registry: RegistrySnapshot;
  loaded: LoadedWorkspaceExtensions | null;
  report: (error: unknown) => void;
}): Promise<LoadedWorkspaceExtensions | null> {
  if (input.agent.scope.kind === "system") {
    return input.loaded ? null : { fingerprint: "", extensions: [] };
  }
  // The extensions being replaced do not conflict with their own replacements.
  const replaced = new Set(input.loaded?.extensions.map((extension) => extension.name));
  const kept = ({ extension }: { extension: Extension }) => !replaced.has(extension.name);
  const installed: Extension[] = [];
  const names = new Set(
    input.registry
      .installed()
      .filter((extension) => kept({ extension }))
      .map((extension) => extension.name),
  );
  const keys = new Set([
    "backoffice",
    ...input.registry
      .sections()
      .filter(kept)
      .map(({ section }) => section.key),
  ]);
  const tools = new Set(
    input.registry
      .tools()
      .filter(kept)
      .map(({ tool }) => tool.name),
  );
  const validationRegistry = createRegistry();
  let state: BackofficeStateBackend;
  let manifestText: string;
  try {
    // Every scope member reads the same workspace, so whichever turn loads it sees the same files.
    const { turn } = input;
    await turn.authorize();
    const turnState = turn.toolContext(
      `${input.agent.agentName}:workspace-extension-load`,
      BACKGROUND_CONTEXT,
    ).stateBackend;
    if (!turnState || !(await turnState.exists(PI_WORKSPACE_EXTENSION_MANIFEST))) {
      return input.loaded?.fingerprint === "" ? null : { fingerprint: "", extensions: [] };
    }
    state = turnState;
    manifestText = await state.readFile(PI_WORKSPACE_EXTENSION_MANIFEST);
  } catch (error) {
    // Without a readable workspace the agent keeps the extensions it has.
    input.report(
      new Error(`PI_EXTENSION_LOAD_FAILED: ${PI_WORKSPACE_EXTENSION_MANIFEST}`, { cause: error }),
    );
    return null;
  }
  let prepared: { paths: string[]; codemode: CodemodeRunner; fingerprint: string };
  try {
    const manifest = z
      .strictObject({ extensions: z.array(extensionFilePathSchema).max(16) })
      .parse(JSON.parse(manifestText) as unknown);
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
    // Rebuilding an artifact rewrites it, so its size and modification time identify the build.
    const artifacts = await Promise.all(
      paths.map(async (path) => {
        const file = await state.stat(path);
        return file ? [file.size, file.mtime.getTime()] : null;
      }),
    );
    const fingerprint = JSON.stringify([manifestText, artifacts]);
    if (input.loaded?.fingerprint === fingerprint) {
      return null;
    }
    if (input.turn.codemode === null) {
      throw new Error("PI_EXTENSION_CODEMODE_UNAVAILABLE");
    }
    prepared = { paths, codemode: input.turn.codemode, fingerprint };
  } catch (error) {
    input.report(
      new Error(`PI_EXTENSION_LOAD_FAILED: ${PI_WORKSPACE_EXTENSION_MANIFEST}`, { cause: error }),
    );
    // An unusable manifest stays unloaded until it changes.
    return { fingerprint: manifestText, extensions: [] };
  }
  const { codemode, paths, fingerprint } = prepared;
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
          codemode,
          origin: { kind: "file", path },
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
        agent: input.agent,
        metadata,
        bundle: artifact.bundle,
        path,
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
  return { fingerprint, extensions: installed };
}
