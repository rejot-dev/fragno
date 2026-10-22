import { normalizeCode } from "@fragno-dev/codemode/runtime-api";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";

import { readSavedModuleImports } from "./saved-module-imports";

/**
 * A durable workflow's code: the module at `filename` exports the workflow by default, and
 * `modules` holds that module with every saved module it imports, so each tick runs the same code.
 */
export type CodemodeWorkflowProgram = {
  filename: string;
  modules: Record<string, string>;
  workflowName: string;
};

/** Names the place in a workflow module that cannot define a workflow, so checks can point at it. */
export class WorkflowModuleError extends BackofficeOperationError {
  constructor(
    readonly path: string,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super("invalid_request", message);
    this.name = "WorkflowModuleError";
  }
}

/** Finds the one `defineWorkflow(...)` in source, which names the workflow before it runs. */
function findWorkflowDefinition(filename: string, code: string) {
  const workflows = visualizeWorkflowSource(filename, code).graph.nodes.filter(
    (node) => node.kind === "workflow",
  );
  const [workflow] = workflows;
  if (workflows.length !== 1 || !workflow) {
    throw new WorkflowModuleError(
      filename,
      1,
      1,
      `Workflow program '${filename}' must contain exactly one defineWorkflow(...) declaration.`,
    );
  }
  const workflowName = workflow.name.trim();
  if (!workflowName) {
    throw new WorkflowModuleError(
      filename,
      workflow.source.start.line,
      workflow.source.start.column + 1,
      `Workflow program '${filename}' must declare a static workflow name.`,
    );
  }
  return { workflowName, start: workflow.source.start };
}

/** A saved workflow module exports its one workflow by default, as its runner imports it. */
export function savedWorkflowName(filename: string, code: string): string {
  const { workflowName, start } = findWorkflowDefinition(filename, code);
  if (!/\bexport\s+default\s*$/u.test(code.slice(0, start.offset))) {
    throw new WorkflowModuleError(
      filename,
      start.line,
      start.column + 1,
      `Workflow module '${filename}' must export its workflow: export default defineWorkflow(...).`,
    );
  }
  return workflowName;
}

/**
 * Workflow files saved before workflows were modules hold one top-level `defineWorkflow(...)`
 * expression, which runs unchanged as the module's default export. The saved file keeps its bytes,
 * so Marketplace-installed files still match their lock; `js.check` still asks for the export.
 */
function exportLegacyWorkflow(code: string) {
  // A module that already exports may place its definition on a later, indented line.
  return /\bexport\s+default\b/u.test(code)
    ? code
    : code.replace(/^(\s*)(defineWorkflow\s*\()/mu, "$1export default $2");
}

/** Reads a saved workflow module and the saved modules it imports, as its instances pin them. */
export async function readSavedWorkflowProgram(input: {
  path: string;
  readFile: (path: string) => Promise<string>;
}): Promise<CodemodeWorkflowProgram> {
  if (!input.path.endsWith(".workflow.js")) {
    throw new BackofficeOperationError(
      "invalid_request",
      `Saved workflow path '${input.path}' must end with '.workflow.js'.`,
    );
  }
  const { modules } = await readSavedModuleImports({
    readFile: input.readFile,
    program: { kind: "file", path: input.path },
  });
  // Reading a file program always includes the file itself.
  const code = exportLegacyWorkflow(modules[input.path]);
  return {
    filename: input.path,
    modules: { ...modules, [input.path]: code },
    workflowName: savedWorkflowName(input.path, code),
  };
}

/** Wraps an inline workflow expression in a module that exports its value. */
function inlineWorkflowModuleSource(code: string) {
  return `export default (\n${normalizeCode(code.trim().replace(/;*$/u, ""))}\n);\n`;
}

/**
 * Inline code is one expression with no file of its own; as a durable program it becomes a module
 * at `filename` that exports the expression's value.
 */
export function inlineWorkflowProgram(input: {
  filename: string;
  code: string;
  /** Saved modules the code imports, as reading its imports found them. */
  modules: Record<string, string>;
}): CodemodeWorkflowProgram {
  const code = normalizeCode(input.code);
  const { workflowName, start } = findWorkflowDefinition(input.filename, code);
  // Only parentheses and comments may precede it, so the expression's value is the definition.
  if (!/^(?:\s|\(|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/u.test(code.slice(0, start.offset))) {
    throw new WorkflowModuleError(
      input.filename,
      start.line,
      start.column + 1,
      "An inline workflow is a top-level defineWorkflow(...) expression, not wrapped in a function.",
    );
  }
  return {
    filename: input.filename,
    modules: { ...input.modules, [input.filename]: inlineWorkflowModuleSource(input.code) },
    workflowName,
  };
}
