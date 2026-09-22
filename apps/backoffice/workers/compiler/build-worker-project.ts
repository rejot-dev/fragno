import {
  InMemoryFileSystem,
  createWorker,
  installDependencies,
  type Modules,
} from "@cloudflare/worker-bundler";

import {
  WorkerCompilationError,
  type CompiledWorker,
  type CompileWorkerInput,
  type WorkerCompiler,
} from "@/backoffice-runtime/dynamic-workers/compile-worker";
import { createWorkerBundle } from "@/backoffice-runtime/dynamic-workers/worker-bundle";

import { WORKER_COMPILER_RUNTIME_DECLARATIONS } from "./compiler-runtime-declarations";

const COMPILER_OWNED_PATHS = new Set([
  "compiler-runtime.d.ts",
  "package.json",
  "tsconfig.json",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);
const WORKER_PACKAGE_EXPORT_CONDITIONS = ["workerd", "worker", "browser"];

function validateCompileWorkerInput(input: CompileWorkerInput) {
  const entryPoint = input.entryPoint.trim();
  if (!entryPoint) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Worker compilation requires an entry point.",
    );
  }
  if (!Object.hasOwn(input.files, entryPoint)) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Worker entry point '${entryPoint}' is missing from the source files.`,
    );
  }

  for (const path of Object.keys(input.files)) {
    if (COMPILER_OWNED_PATHS.has(path)) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        `Worker source path '${path}' is owned by the compiler.`,
      );
    }
  }

  for (const [packageName, versionRange] of Object.entries(input.dependencies)) {
    if (
      !packageName.trim() ||
      packageName !== packageName.trim() ||
      !versionRange.trim() ||
      versionRange !== versionRange.trim()
    ) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        "Worker dependencies require non-empty, trimmed package names and version ranges.",
      );
    }
  }

  return entryPoint;
}

function readEsModuleSources(modules: Modules) {
  const moduleSources: Record<string, string> = {};

  for (const [moduleName, module] of Object.entries(modules)) {
    if (typeof module !== "string") {
      throw new WorkerCompilationError(
        "UNSUPPORTED_MODULE",
        `Worker bundler emitted non-ES module '${moduleName}'.`,
      );
    }
    moduleSources[moduleName] = module;
  }

  return moduleSources;
}

/** Builds one complete in-memory Worker project without retaining request state. */
export const buildWorkerProject: WorkerCompiler = async function buildWorkerProject(
  input,
): Promise<CompiledWorker> {
  const entryPoint = validateCompileWorkerInput(input);
  const compatibilityFlags = [...new Set(input.runtime.compatibilityFlags)];
  const fileSystem = new InMemoryFileSystem({
    ...input.files,
    "compiler-runtime.d.ts": WORKER_COMPILER_RUNTIME_DECLARATIONS,
    "package.json": JSON.stringify({ private: true, dependencies: input.dependencies }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        lib: ["es2024", "webworker"],
        module: "es2022",
        moduleResolution: "bundler",
        target: "es2022",
      },
      include: ["compiler-runtime.d.ts"],
    }),
    "wrangler.json": JSON.stringify({
      main: entryPoint,
      compatibility_date: input.runtime.compatibilityDate,
      compatibility_flags: compatibilityFlags,
    }),
  });

  if (Object.keys(input.dependencies).length > 0) {
    const installation = await installDependencies(fileSystem);
    if (installation.warnings.length > 0) {
      throw new WorkerCompilationError(
        "DEPENDENCY_INSTALL_FAILED",
        `Failed to install Worker dependencies: ${installation.warnings.join("; ")}`,
      );
    }
  }

  const build = await createWorker({
    files: fileSystem,
    entryPoint,
    bundle: true,
    target: "es2022",
    conditions: WORKER_PACKAGE_EXPORT_CONDITIONS,
  });

  return {
    bundle: createWorkerBundle({
      mainModule: build.mainModule,
      modules: readEsModuleSources(build.modules),
      runtime: {
        compatibilityDate: input.runtime.compatibilityDate,
        compatibilityFlags,
      },
    }),
    warnings: build.warnings ?? [],
  };
};
