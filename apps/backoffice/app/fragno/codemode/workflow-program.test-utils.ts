import type { CodemodeWorkflowProgram } from "./workflow-program";

/** A workflow module that exports `run`, an async `(event, step)` function, as its workflow. */
export function testWorkflowProgram(
  run: string,
): Pick<CodemodeWorkflowProgram, "filename" | "modules"> {
  const filename = "/workspace/automations/test.workflow.js";
  return {
    filename,
    modules: { [filename]: `export default defineWorkflow({ name: "test" }, ${run});\n` },
  };
}
