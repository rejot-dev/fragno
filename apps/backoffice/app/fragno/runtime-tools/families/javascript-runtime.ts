import jsTokens, { type Token } from "js-tokens";

import type {
  TypeCheckDiagnostic,
  WorkerTypeChecker,
} from "@/backoffice-runtime/dynamic-workers/compile-worker";
import { isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import type { BackofficeCodemodeExecuteResult } from "@/fragno/codemode/execute";
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

export type JavaScriptModuleExecutor = (
  code: string,
  toolContext: CoreBackofficeToolContext,
) => Promise<BackofficeCodemodeExecuteResult>;

export type JavaScriptRuntime = {
  checkFile: ((input: { path: string }) => Promise<JavaScriptCheckFileOutput>) | null;
  runFile:
    | ((
        input: { path: string },
        toolContext: CoreBackofficeToolContext,
      ) => Promise<JavaScriptRunFileOutput>)
    | null;
};

function parseJavaScriptFilePath(path: string) {
  if (!path.trim().startsWith("/")) {
    throw new Error("JavaScript file path must be absolute.");
  }
  const normalizedPath = normalizeAbsolutePath(path);
  if (!JAVASCRIPT_FILE_ROOTS.some((root) => isPathWithin(normalizedPath, root))) {
    throw new Error("JavaScript file path must be under /static or /workspace.");
  }
  if (!normalizedPath.endsWith(".js")) {
    throw new Error("JavaScript file path must identify a .js file.");
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

    let braceDepth = 0;
    for (const candidate of tokens.slice(index + 1)) {
      if (candidate.token.value === "{") {
        braceDepth += 1;
      } else if (candidate.token.value === "}") {
        braceDepth -= 1;
      } else if (candidate.token.value === "from" && braceDepth === 0) {
        return standaloneJavaScriptImportViolation(code, positionedToken);
      } else if (candidate.token.value === ";" && braceDepth === 0) {
        break;
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
    checkFile: typeCheckFiles
      ? async function checkJavaScriptFile({ path }) {
          const sourcePath = parseJavaScriptFilePath(path);
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
          const sourcePath = parseJavaScriptFilePath(path);
          if (sourcePath.endsWith(".workflow.js")) {
            return {
              status: "error",
              path: sourcePath,
              error:
                "JavaScript run cannot execute a workflow file. Use workflow.instances.create instead.",
              logs: [],
            };
          }
          const stateBackend = await getStateBackend();
          const sourceCode = await stateBackend.readFile(sourcePath);
          const importViolation = findStandaloneJavaScriptImport(sourceCode);
          if (importViolation) {
            return {
              status: "error",
              path: sourcePath,
              error: standaloneJavaScriptImportError(sourcePath, importViolation),
              logs: [],
            };
          }
          const execution = await executeModule(sourceCode, toolContext);
          const logs = execution.logs ?? [];

          if (execution.error) {
            return { status: "error", path: sourcePath, error: execution.error, logs };
          }
          return {
            status: "success",
            path: sourcePath,
            logs,
          };
        }
      : null,
  };
}
