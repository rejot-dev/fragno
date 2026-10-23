import type {
  javascriptOperations,
  JavaScriptRunsListInput,
} from "@fragno-dev/backoffice-api/v0/javascript";
import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import type {
  TypeCheckDiagnostic,
  WorkerTypeChecker,
} from "@fragno-dev/codemode/compiler/compile-worker";
import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import type { CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import type { z } from "zod";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { isPathWithin, normalizeAbsolutePath } from "@/files/normalize-path";
import { builtJavaScriptModuleSchema } from "@/fragno/codemode/built-javascript-module";
import {
  readSavedModuleImports,
  SavedModuleImportError,
} from "@/fragno/codemode/saved-module-imports";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { savedWorkflowName, WorkflowModuleError } from "@/fragno/codemode/workflow-program";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

const JAVASCRIPT_FILE_ROOTS = ["/static", "/workspace"] as const;
const JAVASCRIPT_DECLARATION_ROOT = "/static";
const SAVED_MODULE_IMPORT_DIAGNOSTIC_CODE = 95001;
const WORKFLOW_MODULE_DIAGNOSTIC_CODE = 95002;

/** A workflow file runs only as the workflow it exports, so checking it checks that export too. */
function workflowModuleDiagnostics(path: string, code: string) {
  if (!path.endsWith(".workflow.js")) {
    return [];
  }
  try {
    savedWorkflowName(path, code);
    return [];
  } catch (error) {
    if (!(error instanceof WorkflowModuleError)) {
      throw error;
    }
    return [
      {
        code: WORKFLOW_MODULE_DIAGNOSTIC_CODE,
        path: error.path,
        line: error.line,
        column: error.column,
        message: error.message,
      },
    ];
  }
}

export type JavaScriptCheckFileOutput = {
  path: string;
  valid: boolean;
  diagnostics: TypeCheckDiagnostic[];
};

/** A recorded run's outcome; its run ID leads to the run's retained logs and tool calls. */
export type JavaScriptModuleExecution =
  | { status: "success"; runId: string; logs: CodemodeLogLine[] }
  | { status: "error"; runId: string; error: string; logs: CodemodeLogLine[] };

/** `rejected` means no run result: the file was refused or execution could not start or report. */
export type JavaScriptRunFileOutput =
  | (JavaScriptModuleExecution & { path: string })
  | { status: "rejected"; path: string; error: string };

export type JavaScriptRunsListOutput = z.output<
  (typeof javascriptOperations)["js.runs.list"]["output"]
>;

export type JavaScriptRunsGetOutput = z.output<
  (typeof javascriptOperations)["js.runs.get"]["output"]
>;

/** The current scope's retained runs, readable only with at least each run's authority. */
export type JavaScriptRunHistory = {
  listRuns(input: JavaScriptRunsListInput): Promise<JavaScriptRunsListOutput>;
  getRun(input: { runId: string }): Promise<JavaScriptRunsGetOutput>;
};

export type JavaScriptBuildFileInput = { path: string; out: string };

export type JavaScriptBuildFileOutput =
  | { status: "success"; path: string; outputPath: string; runId: string; warnings: string[] }
  | { status: "error"; path: string; outputPath: string; runId: string; error: string }
  | { status: "rejected"; path: string; outputPath: string; error: string };

/**
 * A saved file to run: source requires compilation together with the saved modules it imports,
 * including itself; a validated bundle runs without a compiler.
 */
export type JavaScriptModuleProgram =
  | { kind: "source"; path: string; modules: Record<string, string> }
  | { kind: "bundle"; path: string; bundle: WorkerBundle };

export type JavaScriptModuleExecutor = (
  program: JavaScriptModuleProgram,
  toolContext: CoreBackofficeToolContext,
) => Promise<JavaScriptModuleExecution>;

export type JavaScriptRuntime = {
  buildFile: ((input: JavaScriptBuildFileInput) => Promise<JavaScriptBuildFileOutput>) | null;
  checkFile: ((input: { path: string }) => Promise<JavaScriptCheckFileOutput>) | null;
  runFile:
    | ((
        input: { path: string },
        toolContext: CoreBackofficeToolContext,
      ) => Promise<JavaScriptRunFileOutput>)
    | null;
  runHistory: JavaScriptRunHistory | null;
};

function parseJavaScriptFilePath(path: string, kind: "source" | "run") {
  if (!path.trim().startsWith("/")) {
    throw new BackofficeOperationError("invalid_request", "JavaScript file path must be absolute.");
  }
  const normalizedPath = normalizeAbsolutePath(path);
  if (!JAVASCRIPT_FILE_ROOTS.some((root) => isPathWithin(normalizedPath, root))) {
    throw new BackofficeOperationError(
      "invalid_request",
      "JavaScript file path must be under /static or /workspace.",
    );
  }
  if (!normalizedPath.endsWith(".js") && (kind === "source" || !normalizedPath.endsWith(".json"))) {
    throw new BackofficeOperationError(
      "invalid_request",
      kind === "source"
        ? "JavaScript file path must identify a .js file."
        : "JavaScript run path must identify a .js source file or built .json module.",
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
    runHistory: null,
    checkFile: typeCheckFiles
      ? async function checkJavaScriptFile({ path }) {
          const sourcePath = parseJavaScriptFilePath(path, "source");
          const stateBackend = await getStateBackend();
          let modules: Record<string, string>;
          try {
            ({ modules } = await readSavedModuleImports({
              readFile: (modulePath) => stateBackend.readFile(modulePath),
              program: { kind: "file", path: sourcePath },
            }));
          } catch (error) {
            if (!(error instanceof SavedModuleImportError)) {
              throw error;
            }
            return {
              path: sourcePath,
              valid: false,
              diagnostics: [
                {
                  code: SAVED_MODULE_IMPORT_DIAGNOSTIC_CODE,
                  path: error.path,
                  line: error.line,
                  column: error.column,
                  message: error.message,
                },
              ],
            };
          }

          const declarationPaths = await listTypeScriptDeclarationPaths(
            stateBackend,
            JAVASCRIPT_DECLARATION_ROOT,
          );
          // Imported modules are checked too; their errors surface where they are written.
          const sourcePaths = Object.keys(modules).map(javaScriptVirtualPath);
          const result = await typeCheckFiles({
            files: [
              ...Object.entries(modules).map(([modulePath, code]) => ({
                path: javaScriptVirtualPath(modulePath),
                read: async () => code,
              })),
              ...declarationPaths.map((declarationPath) => ({
                path: javaScriptVirtualPath(declarationPath),
                read: async () => await stateBackend.readFile(declarationPath),
              })),
            ],
            sourcePaths,
          });
          const diagnostics = [
            // Reading a file program always includes the file itself.
            ...workflowModuleDiagnostics(sourcePath, modules[sourcePath]),
            ...result.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              path:
                diagnostic.path === null || diagnostic.path.startsWith("/")
                  ? diagnostic.path
                  : `/${diagnostic.path}`,
            })),
          ];

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
                throw new BackofficeOperationError(
                  "not_found",
                  `JAVASCRIPT_RUN_BUILT_MODULE_MISSING: ${sourcePath}`,
                );
              }
              if (file.size > CODEMODE_LIMITS.maxBundleBytes) {
                throw new Error("JAVASCRIPT_RUN_BUILT_MODULE_TOO_LARGE");
              }
              const { bundle } = builtJavaScriptModuleSchema.parse(
                await stateBackend.readJson(sourcePath),
              );
              program = { kind: "bundle", path: sourcePath, bundle };
            } else {
              if (sourcePath.endsWith(".workflow.js")) {
                throw new Error(
                  "JavaScript run cannot execute a workflow file. Use workflow.instances.create instead.",
                );
              }
              const { modules, packages } = await readSavedModuleImports({
                readFile: (modulePath) => stateBackend.readFile(modulePath),
                program: { kind: "file", path: sourcePath },
              });
              if (packages.length > 0) {
                throw new Error(
                  `JavaScript run cannot install packages (${packages.join(", ")}); compile with js.build and run the built module.`,
                );
              }
              program = { kind: "source", path: sourcePath, modules };
            }
            return { ...(await executeModule(program, toolContext)), path: sourcePath };
          } catch (error) {
            return {
              status: "rejected",
              path: sourcePath,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      : null,
  };
}
