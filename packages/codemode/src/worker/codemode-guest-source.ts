import { CODEMODE_LIMITS } from "../codemode-limits";
import { normalizeCode, type ResolvedProvider } from "../runtime-api";

/**
 * Guest runtime adapted from agents/packages/codemode/src/executor.ts on 2026-06-05.
 * Source repository HEAD: d6827ab03fa703058e755d17e3f5db0cd90c94b6
 * Source file last-changed commit: f739ec9cd74c73da6a2d68403ab05f20940e36af
 * Source generation has no Worker Loader or Cloudflare RPC runtime dependency.
 */

/** Shared guest source for provider binary values and workflow definitions, not WebSocket frames. */
export const CODEMODE_SANDBOX_CODEC_SOURCE = String.raw`
const __CODEMODE_BINARY_TAG = "__codemode_binary_v1__";
const __FRAGNO_CODEMODE_WORKFLOW_TAG = "__fragno_codemode_workflow_v1__";
function __bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}
function __base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function __encodeCodemodeValue(value) {
  if (value instanceof Uint8Array) {
    return { [__CODEMODE_BINARY_TAG]: "Uint8Array", data: __bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { [__CODEMODE_BINARY_TAG]: "ArrayBuffer", data: __bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return { [__CODEMODE_BINARY_TAG]: "ArrayBufferView", data: __bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  return value;
}
function __decodeCodemodeValue(value) {
  if (!value || typeof value !== "object" || !(__CODEMODE_BINARY_TAG in value) || typeof value.data !== "string") return value;
  const bytes = __base64ToBytes(value.data);
  if (value[__CODEMODE_BINARY_TAG] === "ArrayBuffer") {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes;
}
function __stringifyForCodemode(value) {
  return JSON.stringify(value, (_key, nested) => __encodeCodemodeValue(nested));
}
function __parseForCodemode(json) {
  return JSON.parse(json, (_key, nested) => __decodeCodemodeValue(nested));
}
function __throwCodemodeProviderError(encoded) {
  if (!encoded || typeof encoded !== "object") throw new Error(String(encoded));
  const error = new Error(typeof encoded.message === "string" ? encoded.message : "Codemode provider failed.");
  if (typeof encoded.name === "string") error.name = encoded.name;
  if (encoded.details && typeof encoded.details === "object") {
    if (typeof encoded.details.status === "number") error.status = encoded.details.status;
    if (typeof encoded.details.code === "string") error.code = encoded.details.code;
  }
  throw error;
}
function defineWorkflow(options, run) {
  if (!options || typeof options !== "object" || typeof options.name !== "string" || options.name.trim() === "") {
    throw new Error("defineWorkflow requires a non-empty workflow name.");
  }
  if (run === undefined) {
    return (workflowRun) => defineWorkflow(options, workflowRun);
  }
  if (typeof run !== "function") {
    throw new Error("defineWorkflow requires a workflow callback.");
  }
  return { [__FRAGNO_CODEMODE_WORKFLOW_TAG]: true, options, run };
}
function __isFragnoCodemodeWorkflowDefinition(value) {
  return Boolean(value) && typeof value === "object" && value[__FRAGNO_CODEMODE_WORKFLOW_TAG] === true;
}
`;

const INTERNAL_PROVIDER_NAMES = new Set(["__context"]);

function createScopedContextProxySource(): string {
  return String.raw`
    const __createScopedContextHandle = (scope) => new Proxy({}, {
      get: (_, namespace) => {
        if (typeof namespace !== "string") return undefined;
        return new Proxy({}, {
          get: (_, toolName) => {
            if (typeof toolName !== "string") return undefined;
            return async (...args) => {
              const resJson = await __dispatchers.__context.call("callScoped", __stringifyForCodemode([{ scope, namespace, toolName, args }]));
              const data = __parseForCodemode(resJson);
              if (data.error) __throwCodemodeProviderError(data.error);
              return data.result;
            };
          }
        });
      }
    });
    const context = {
      getCurrentScope: async () => {
        const resJson = await __dispatchers.__context.call("getCurrentScope", __stringifyForCodemode([]));
        const data = __parseForCodemode(resJson);
        if (data.error) __throwCodemodeProviderError(data.error);
        return data.result;
      },
      get current() { return __createScopedContextHandle({ kind: "current" }); },
      org: (orgId) => __createScopedContextHandle({ kind: "org", orgId: String(orgId) }),
      user: (userId) => __createScopedContextHandle({ kind: "user", userId: String(userId) }),
      project: (projectId) => __createScopedContextHandle({ kind: "project", projectId: String(projectId) }),
    };`;
}

/** Generates provider proxies; host implementations remain behind the injected dispatchers. */
export function createCodemodeProviderProxySource(providers: readonly ResolvedProvider[]): string {
  return [
    ...providers
      .filter((provider) => !INTERNAL_PROVIDER_NAMES.has(provider.name))
      .map(
        (provider) =>
          `    const ${provider.name} = new Proxy({}, {\n` +
          `      get: (_, toolName) => async (...args) => {\n` +
          `        const resJson = await __dispatchers.${provider.name}.call(String(toolName), __stringifyForCodemode(args));\n` +
          `        const data = __parseForCodemode(resJson);\n` +
          `        if (data.error) __throwCodemodeProviderError(data.error);\n` +
          `        return data.result;\n` +
          `      }\n` +
          `    });`,
      ),
    ...(providers.some((provider) => provider.name === "__context")
      ? [createScopedContextProxySource()]
      : []),
  ].join("\n");
}

/** Generates an expression guest; timeoutMs bounds asynchronous evaluation, not synchronous CPU. */
export function createCodemodeExpressionSource(
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
    CODEMODE_SANDBOX_CODEC_SOURCE,
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

/** Generates a module guest that imports the file without invoking its exported values. */
export function createCodemodeModuleSource(
  modulePath: string,
  providers: readonly ResolvedProvider[],
  timeoutMs?: number,
): string {
  const exposedProviderNames = providers
    .filter((provider) => !INTERNAL_PROVIDER_NAMES.has(provider.name))
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

  return createCodemodeExpressionSource(executeJavaScriptModule, providers, timeoutMs);
}
