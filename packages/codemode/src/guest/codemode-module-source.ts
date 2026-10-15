import type { ResolvedProvider } from "../runtime-api";
import { createCodemodeFunctionSource } from "./codemode-function-source";

/** Generates a module guest that imports the file without invoking its exported values. */
export function createCodemodeModuleSource(
  modulePath: string,
  providers: readonly ResolvedProvider[],
  timeoutMs?: number,
): string {
  const executeJavaScriptModule = [
    "async () => {",
    "  globalThis.defineWorkflow = defineWorkflow;",
    `  await import(${JSON.stringify(modulePath)});`,
    "}",
  ].join("\n");

  return createCodemodeFunctionSource(executeJavaScriptModule, providers, timeoutMs);
}
