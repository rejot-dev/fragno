import { CODEMODE_LIMITS } from "../codemode-limits";
import { normalizeCode, type ResolvedProvider } from "../runtime-api";
import {
  CODEMODE_GUEST_API_SOURCE,
  createCodemodeProviderProxySource,
} from "./codemode-guest-api-source";

/** Generates an immediate expression or function guest; timeoutMs bounds async evaluation, not CPU. */
export function createCodemodeFunctionSource(
  code: string,
  providers: readonly ResolvedProvider[],
  timeoutMs = 30_000,
): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "",
    "export default class CodeExecutor extends WorkerEntrypoint {",
    "  async evaluate(__rpcTargets = {}) {",
    "    const { __dispatchers = {} } = __rpcTargets;",
    "    const __logs = [];",
    `    let __logBytes = 0;
    const __captureLog = (prefix, args) => {
      const text = prefix + args.map(String).join(" ");
      __logBytes += new TextEncoder().encode(text).byteLength;
      if (__logs.length >= ${CODEMODE_LIMITS.maxLogs} || __logBytes > ${CODEMODE_LIMITS.maxLogBytes}) {
        throw new Error("CODEMODE_LOG_LIMIT_EXCEEDED");
      }
      __logs.push(text);
    };
    console.log = (...args) => __captureLog("", args);
    console.warn = (...args) => __captureLog("[warn] ", args);
    console.error = (...args) => __captureLog("[error] ", args);`,
    CODEMODE_GUEST_API_SOURCE,
    createCodemodeProviderProxySource(providers),
    "",
    "    try {",
    "      const program = (" + normalizeCode(code) + ");",
    "      const result = __isFragnoCodemodeWorkflowDefinition(program)",
    "        ? program",
    "        : await Promise.race([",
    '          typeof program === "function" ? program() : Promise.resolve(program),',
    `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
    "        ]);",
    "      if (__isFragnoCodemodeWorkflowDefinition(result)) {",
    "        return { ok: true, result: undefined, error: null, workflowDefinition: { name: String(result.options.name), options: result.options }, logs: __logs };",
    "      }",
    "      return { ok: true, result, error: null, workflowDefinition: null, logs: __logs };",
    "    } catch (error) {",
    '      const message = error instanceof Error || (error !== null && typeof error === "object" && typeof error.message === "string")',
    "        ? error.message",
    "        : String(error);",
    '      return { ok: false, result: undefined, error: message || "CODEMODE_EXECUTION_FAILED", workflowDefinition: null, logs: __logs };',
    "    }",
    "  }",
    "}",
  ].join("\n");
}
