import type { ResolvedProvider } from "../runtime-api";
import { createCodemodeFunctionSource } from "./codemode-function-source";

/** Invokes a caller-supplied function with a module namespace inside the isolated guest. */
export function createCodemodeModuleInvocationSource(
  invocation: string,
  providers: readonly ResolvedProvider[],
  timeoutMs: number,
  moduleSpecifier: string,
): string {
  return createCodemodeFunctionSource(
    `async () => {
      const module = await import(${JSON.stringify(moduleSpecifier)});
      return await (${invocation})(module, __input);
    }`,
    providers,
    timeoutMs,
  );
}
