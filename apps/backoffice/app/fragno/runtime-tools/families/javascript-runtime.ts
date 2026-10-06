import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import type {
  TypeCheckDiagnostic,
  WorkerTypeChecker,
} from "@fragno-dev/codemode/compiler/compile-worker";
import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import jsTokens, { type Token } from "js-tokens";

import { isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import type { BackofficeCodemodeExecuteResult } from "@/fragno/codemode/execute";
import { javaScriptModuleArtifactSchema } from "@/fragno/codemode/javascript-module-artifact";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

const JAVASCRIPT_FILE_ROOTS = ["/static", "/workspace"] as const;
const JAVASCRIPT_DECLARATION_ROOT = "/static";
const STANDALONE_JAVASCRIPT_IMPORT_DIAGNOSTIC_CODE = 95001;

type StandaloneJavaScriptImportViolation = {
  line: number;
  column: number;
};

type PositionedJavaScriptToken = {
  token: Token;
  start: number;
};

export type JavaScriptCheckFileOutput = {
  path: string;
  valid: boolean;
  diagnostics: TypeCheckDiagnostic[];
};

export type JavaScriptRunFileOutput =
  | {
      status: "success";
      path: string;
      logs: string[];
    }
  | {
      status: "error";
      path: string;
      error: string;
      logs: string[];
    };

export type JavaScriptBuildFileInput = { path: string; out: string };

export type JavaScriptBuildFileOutput =
  | { status: "success"; path: string; artifactPath: string; warnings: string[] }
  | { status: "error"; path: string; artifactPath: string; error: string };

/** Source requires compilation; a validated bundle must run without consulting a compiler. */
export type JavaScriptModuleProgram =
  | { kind: "source"; code: string }
  | { kind: "bundle"; bundle: WorkerBundle };

export type JavaScriptModuleExecutor = (
  program: JavaScriptModuleProgram,
  toolContext: CoreBackofficeToolContext,
) => Promise<BackofficeCodemodeExecuteResult>;

export type JavaScriptRuntime = {
  buildFile: ((input: JavaScriptBuildFileInput) => Promise<JavaScriptBuildFileOutput>) | null;
  checkFile: ((input: { path: string }) => Promise<JavaScriptCheckFileOutput>) | null;
  runFile:
    | ((
        input: { path: string },
        toolContext: CoreBackofficeToolContext,
      ) => Promise<JavaScriptRunFileOutput>)
    | null;
};

function parseJavaScriptFilePath(path: string, kind: "source" | "run") {
  if (!path.trim().startsWith("/")) {
    throw new Error("JavaScript file path must be absolute.");
  }
  const normalizedPath = normalizeAbsolutePath(path);
  if (!JAVASCRIPT_FILE_ROOTS.some((root) => isPathWithin(normalizedPath, root))) {
    throw new Error("JavaScript file path must be under /static or /workspace.");
  }
  if (!normalizedPath.endsWith(".js") && (kind === "source" || !normalizedPath.endsWith(".json"))) {
    throw new Error(
      kind === "source"
        ? "JavaScript file path must identify a .js file."
        : "JavaScript run path must identify a .js source file or .json module artifact.",
    );
  }
  return normalizedPath;
}

async function listTypeScriptDeclarationPaths(
  stateBackend: BackofficeStateBackend,
  directory: string,
): Promise<string[]> {
  const paths: string[] = [];
  const entries = (await stateBackend.readdirWithFileTypes(directory))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = stateBackend.resolvePath(directory, entry.name);
    if (entry.type === "directory") {
      paths.push(...(await listTypeScriptDeclarationPaths(stateBackend, path)));
    } else if (path.endsWith(".d.ts")) {
      paths.push(path);
    }
  }

  return paths;
}

function javaScriptVirtualPath(path: string) {
  return path.slice(1);
}

function isJavaScriptTriviaToken(token: Token) {
  return (
    token.type === "WhiteSpace" ||
    token.type === "LineTerminatorSequence" ||
    token.type === "SingleLineComment" ||
    token.type === "MultiLineComment" ||
    token.type === "HashbangComment"
  );
}

function positionJavaScriptTokens(code: string) {
  let offset = 0;
  return [...jsTokens(code)].map((token): PositionedJavaScriptToken => {
    const positionedToken = { token, start: offset };
    offset += token.value.length;
    return positionedToken;
  });
}

function standaloneJavaScriptImportViolation(
  code: string,
  token: PositionedJavaScriptToken,
): StandaloneJavaScriptImportViolation {
  const precedingLines = code.slice(0, token.start).split(/\r\n|[\n\r\u2028\u2029]/u);
  return {
    line: precedingLines.length,
    column: (precedingLines.at(-1)?.length ?? 0) + 1,
  };
}

function findStandaloneJavaScriptImport(code: string): StandaloneJavaScriptImportViolation | null {
  const tokens = positionJavaScriptTokens(code).filter(
    ({ token }) => !isJavaScriptTriviaToken(token),
  );

  for (const [index, positionedToken] of tokens.entries()) {
    const { token } = positionedToken;
    const previousValue = tokens[index - 1]?.token.value;
    const nextValue = tokens[index + 1]?.token.value;

    if (token.type === "IdentifierName" && token.value === "import") {
      if (
        previousValue !== "." &&
        previousValue !== "?." &&
        nextValue !== "." &&
        nextValue !== ":"
      ) {
        return standaloneJavaScriptImportViolation(code, positionedToken);
      }
      continue;
    }

    if (
      token.type !== "IdentifierName" ||
      token.value !== "export" ||
      previousValue === "." ||
      (nextValue !== "*" && nextValue !== "{")
    ) {
      continue;
    }

    if (nextValue === "*") {
      return standaloneJavaScriptImportViolation(code, positionedToken);
    }

    let braceDepth = 0;
    for (const [candidateOffset, candidate] of tokens.slice(index + 1).entries()) {
      if (candidate.token.value === "{") {
        braceDepth += 1;
      } else if (candidate.token.value === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          const tokenAfterExportList = tokens[index + candidateOffset + 2]?.token.value;
          if (tokenAfterExportList === "from") {
            return standaloneJavaScriptImportViolation(code, positionedToken);
          }
          break;
        }
      }
    }
  }

  return null;
}

function standaloneJavaScriptImportError(
  path: string,
  violation: StandaloneJavaScriptImportViolation,
) {
  return `Standalone JavaScript import is not supported in '${path}' at line ${violation.line}, column ${violation.column}. Saved JavaScript files must not import other modules.`;
}

/** Creates file-backed JavaScript checking and ES module execution under /static and /workspace. */
export function createJavaScriptRuntime({
  getStateBackend,
  typeCheckFiles,
  executeModule,
}: {
  getStateBackend: () => Promise<BackofficeStateBackend>;
  typeCheckFiles: WorkerTypeChecker | null;
  executeModule: JavaScriptModuleExecutor | null;
}): JavaScriptRuntime {
  return {
    buildFile: null,
    checkFile: typeCheckFiles
      ? async function checkJavaScriptFile({ path }) {
          const sourcePath = parseJavaScriptFilePath(path, "source");
          const stateBackend = await getStateBackend();
          const sourceCode = await stateBackend.readFile(sourcePath);
          const importViolation = findStandaloneJavaScriptImport(sourceCode);
          if (importViolation) {
            return {
              path: sourcePath,
              valid: false,
              diagnostics: [
                {
                  code: STANDALONE_JAVASCRIPT_IMPORT_DIAGNOSTIC_CODE,
                  path: sourcePath,
                  line: importViolation.line,
                  column: importViolation.column,
                  message: standaloneJavaScriptImportError(sourcePath, importViolation),
                },
              ],
            };
          }

          const declarationPaths = await listTypeScriptDeclarationPaths(
            stateBackend,
            JAVASCRIPT_DECLARATION_ROOT,
          );
          const sourceVirtualPath = javaScriptVirtualPath(sourcePath);
          const result = await typeCheckFiles({
            files: [
              { path: sourceVirtualPath, read: async () => sourceCode },
              ...declarationPaths.map((declarationPath) => ({
                path: javaScriptVirtualPath(declarationPath),
                read: async () => await stateBackend.readFile(declarationPath),
              })),
            ],
            sourcePaths: [sourceVirtualPath],
          });
          const diagnostics = result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            path:
              diagnostic.path === null || diagnostic.path.startsWith("/")
                ? diagnostic.path
                : `/${diagnostic.path}`,
          }));

          return {
            path: sourcePath,
            valid: diagnostics.length === 0,
            diagnostics,
          };
        }
      : null,
    runFile: executeModule
      ? async function runJavaScriptFile({ path }, toolContext) {
          const sourcePath = parseJavaScriptFilePath(path, "run");
          try {
            const stateBackend = await getStateBackend();
            let program: JavaScriptModuleProgram;
            if (sourcePath.endsWith(".json")) {
              const file = await stateBackend.stat(sourcePath);
              if (file?.type !== "file") {
                throw new Error(`JAVASCRIPT_RUN_ARTIFACT_MISSING: ${sourcePath}`);
              }
              if (file.size > CODEMODE_LIMITS.maxBundleBytes) {
                throw new Error("JAVASCRIPT_RUN_ARTIFACT_TOO_LARGE");
              }
              const { bundle } = javaScriptModuleArtifactSchema.parse(
                await stateBackend.readJson(sourcePath),
              );
              program = { kind: "bundle", bundle };
            } else {
              if (sourcePath.endsWith(".workflow.js")) {
                throw new Error(
                  "JavaScript run cannot execute a workflow file. Use workflow.instances.create instead.",
                );
              }
              const code = await stateBackend.readFile(sourcePath);
              const importViolation = findStandaloneJavaScriptImport(code);
              if (importViolation) {
                throw new Error(standaloneJavaScriptImportError(sourcePath, importViolation));
              }
              program = { kind: "source", code };
            }
            const execution = await executeModule(program, toolContext);
            const logs = execution.logs ?? [];
            return execution.error
              ? { status: "error", path: sourcePath, error: execution.error, logs }
              : { status: "success", path: sourcePath, logs };
          } catch (error) {
            return {
              status: "error",
              path: sourcePath,
              error: error instanceof Error ? error.message : String(error),
              logs: [],
            };
          }
        }
      : null,
  };
}
