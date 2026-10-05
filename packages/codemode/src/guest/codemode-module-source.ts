import type { ResolvedProvider } from "../runtime-api";
import { createCodemodeFunctionSource } from "./codemode-function-source";
import { CODEMODE_INTERNAL_PROVIDER_NAMES } from "./codemode-guest-api-source";

/** Generates a module guest that imports the file without invoking its exported values. */
export function createCodemodeModuleSource(
  modulePath: string,
  providers: readonly ResolvedProvider[],
  timeoutMs?: number,
): string {
  const exposedProviderNames = providers
    .filter((provider) => !CODEMODE_INTERNAL_PROVIDER_NAMES.has(provider.name))
    .map((provider) => provider.name);
  if (providers.some((provider) => provider.name === "__context")) {
    exposedProviderNames.push("context");
  }

  const executeJavaScriptModule = [
    "async () => {",
    ...exposedProviderNames.map(
      (providerName) => `  globalThis[${JSON.stringify(providerName)}] = ${providerName};`,
    ),
    "  globalThis.defineWorkflow = defineWorkflow;",
    `  await import(${JSON.stringify(modulePath)});`,
    "}",
  ].join("\n");

  return createCodemodeFunctionSource(executeJavaScriptModule, providers, timeoutMs);
}
