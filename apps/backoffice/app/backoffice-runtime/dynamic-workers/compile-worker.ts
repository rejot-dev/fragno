import {
  InMemoryFileSystem,
  createWorker,
  installDependencies,
  type Modules,
} from "@cloudflare/worker-bundler";

import { createWorkerBundle, type WorkerBundle } from "./worker-bundle";

const COMPILER_OWNED_PATHS = new Set([
  "package.json",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);
const WORKER_PACKAGE_EXPORT_CONDITIONS = ["workerd", "worker", "browser"];

export type CompileWorkerInput = {
  files: Readonly<Record<string, string>>;
  entryPoint: string;
  dependencies?: Readonly<Record<string, string>>;
  runtime: {
    compatibilityDate: string;
    compatibilityFlags?: readonly string[];
  };
};

export type CompiledWorker = {
  bundle: WorkerBundle;
  warnings: string[];
};

export type WorkerCompiler = (input: CompileWorkerInput) => Promise<CompiledWorker>;

export type WorkerCompilationErrorCode =
  | "INVALID_INPUT"
  | "DEPENDENCY_INSTALL_FAILED"
  | "UNSUPPORTED_MODULE";

export class WorkerCompilationError extends Error {
  readonly code: WorkerCompilationErrorCode;

  constructor(code: WorkerCompilationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerCompilationError";
    this.code = code;
  }
}

const validateCompileWorkerInput = (input: CompileWorkerInput) => {
  const entryPoint = input.entryPoint.trim();
  if (!entryPoint) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Worker compilation requires an entry point.",
    );
  }
  if (!(entryPoint in input.files)) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Worker entry point '${entryPoint}' is missing from the source files.`,
    );
  }

  for (const path of Object.keys(input.files)) {
    if (COMPILER_OWNED_PATHS.has(path) || path.startsWith("node_modules/")) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        `Worker source path '${path}' is owned by the compiler.`,
      );
    }
  }

  for (const [packageName, versionRange] of Object.entries(input.dependencies ?? {})) {
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
};

const readEsModuleSources = (modules: Modules) => {
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
};

export const compileWorker: WorkerCompiler = async (input) => {
  const entryPoint = validateCompileWorkerInput(input);
  const compatibilityFlags = [...new Set(input.runtime.compatibilityFlags ?? [])];
  const fileSystem = new InMemoryFileSystem({
    ...input.files,
    "package.json": JSON.stringify({ private: true, dependencies: input.dependencies ?? {} }),
    "wrangler.json": JSON.stringify({
      main: entryPoint,
      compatibility_date: input.runtime.compatibilityDate,
      compatibility_flags: compatibilityFlags,
    }),
  });

  // Installing explicitly lets dependency failures surface before bundling.
  // createWorker reuses the populated node_modules tree instead of fetching it again.
  const installation = await installDependencies(fileSystem);
  if (installation.warnings.length > 0) {
    throw new WorkerCompilationError(
      "DEPENDENCY_INSTALL_FAILED",
      `Failed to install Worker dependencies: ${installation.warnings.join("; ")}`,
    );
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
