import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";

import { createFileSystemSnapshot, type FileSystem } from "@cloudflare/worker-bundler";

import {
  WorkerCompilationError,
  type TypeCheckDiagnostic,
  type TypeCheckFilesResult,
  type TypeCheckProjectInput,
} from "@/backoffice-runtime/dynamic-workers/compile-worker";

import { WORKER_COMPILER_RUNTIME_DECLARATIONS } from "./compiler-runtime-declarations";
import typeScriptStandardLibraryFiles from "./typescript-standard-library.generated.json";

const COMPILER_OWNED_PATHS = new Set(["compiler-runtime.d.ts", "tsconfig.json"]);
const TYPESCRIPT_COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: true,
  lib: ["es2024", "webworker"],
  module: "es2022",
  moduleResolution: "bundler",
  noEmit: true,
  noResolve: true,
  skipLibCheck: true,
  strict: true,
  target: "es2022",
} as const;

type TypeScriptDiagnostic = {
  code: number;
  file?: {
    fileName: string;
    getLineAndCharacterOfPosition(position: number): { line: number; character: number };
  };
  start?: number;
  messageText: string | { messageText: string; next?: readonly unknown[] };
};

function validateTypeCheckProject(fileSystem: FileSystem, sourcePaths: readonly string[]) {
  for (const path of fileSystem.list()) {
    if (COMPILER_OWNED_PATHS.has(path)) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        `Type-check source path '${path}' is owned by the compiler.`,
      );
    }
  }
  for (const sourcePath of sourcePaths) {
    if (fileSystem.read(sourcePath) === null) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        `Type-check source '${sourcePath}' is missing from the type-check files.`,
      );
    }
  }
}

function flattenTypeScriptDiagnosticMessage(message: TypeScriptDiagnostic["messageText"]): string {
  if (typeof message === "string") {
    return message;
  }
  const nested = message.next?.map((entry) =>
    flattenTypeScriptDiagnosticMessage(entry as TypeScriptDiagnostic["messageText"]),
  );
  return [message.messageText, ...(nested ?? [])].join(" ");
}

function createTypeCheckDiagnostic(diagnostic: TypeScriptDiagnostic): TypeCheckDiagnostic {
  const message = flattenTypeScriptDiagnosticMessage(diagnostic.messageText);
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { code: diagnostic.code, path: null, line: null, column: null, message };
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    code: diagnostic.code,
    path: diagnostic.file.fileName,
    line: position.line + 1,
    column: position.character + 1,
    message,
  };
}

function createTypeScriptConfig(projectPaths: readonly string[]) {
  return JSON.stringify({
    compilerOptions: TYPESCRIPT_COMPILER_OPTIONS,
    include: projectPaths,
  });
}

/** Type checks one streamed project without retaining language-service state. */
export async function typeCheckProject(
  input: TypeCheckProjectInput,
): Promise<TypeCheckFilesResult> {
  const fileSystem = await createFileSystemSnapshot(input.files);
  validateTypeCheckProject(fileSystem, input.sourcePaths);
  fileSystem.write("compiler-runtime.d.ts", WORKER_COMPILER_RUNTIME_DECLARATIONS);
  fileSystem.write("tsconfig.json", createTypeScriptConfig(fileSystem.list()));
  const typescript = await createTypescriptLanguageService({
    fileSystem,
    libraryFiles: typeScriptStandardLibraryFiles,
  });

  // worker-bundler 0.2.2 registers TypeScript roots during initialization. JavaScript sources
  // enter through the synchronized wrapper so allowJs/checkJs sees the caller's authored files.
  for (const sourcePath of input.sourcePaths) {
    if (sourcePath.endsWith(".js")) {
      typescript.fileSystem.write(sourcePath, fileSystem.read(sourcePath)!);
    }
  }

  return {
    diagnostics: [
      ...typescript.languageService.getCompilerOptionsDiagnostics(),
      ...input.sourcePaths.flatMap((path) => [
        ...typescript.languageService.getSyntacticDiagnostics(path),
        ...typescript.languageService.getSemanticDiagnostics(path),
      ]),
    ].map(createTypeCheckDiagnostic),
  };
}
