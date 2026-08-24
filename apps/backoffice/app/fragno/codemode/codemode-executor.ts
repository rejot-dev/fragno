/**
 * Adapted from `/Users/wilco/dev/agents/packages/codemode/src/executor.ts` on 2026-06-05.
 * Source repository HEAD: d6827ab03fa703058e755d17e3f5db0cd90c94b6
 * Source file last-changed commit: f739ec9cd74c73da6a2d68403ab05f20940e36af
 *
 * Backoffice changes:
 * - Owns the small codemode provider/dispatcher API surface Backoffice relies on instead of
 *   importing it from `@cloudflare/codemode` directly.
 * - Keeps the upstream DynamicWorkerExecutor shape, but exposes the provider bridge pieces used by
 *   workflow codemode's custom Dynamic Worker entrypoint.
 * - Adds `createCodemodeDispatchers` and `createCodemodeProviderProxySource` so callers can pass
 *   provider RpcTargets alongside additional RpcTargets such as workflow step targets.
 */
import type { WorkerBundle } from "@/backoffice-runtime/dynamic-workers/worker-bundle";

import {
  normalizeCode,
  resolveProvider,
  sanitizeToolName,
  ToolDispatcher,
  type DynamicWorkerExecutorOptions,
  type ExecuteResult,
  type ResolvedProvider,
  type ToolProvider,
} from "./runtime-api";

export {
  normalizeCode,
  resolveProvider,
  type DynamicWorkerExecutorOptions,
  type ExecuteResult,
  type ResolvedProvider,
  type ToolProvider,
};

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

const RESERVED_PROVIDER_NAMES = new Set([
  "context",
  "__dispatchers",
  "__logs",
  "__CODEMODE_BINARY_TAG",
  "__bytesToBase64",
  "__base64ToBytes",
  "__encodeCodemodeValue",
  "__decodeCodemodeValue",
  "__stringifyForCodemode",
  "__parseForCodemode",
  "__FRAGNO_CODEMODE_WORKFLOW_TAG",
  "defineWorkflow",
  "__isFragnoCodemodeWorkflowDefinition",
]);

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

const validateProviderNames = (providers: readonly ResolvedProvider[]): string | undefined => {
  const seenNames = new Set<string>();
  for (const provider of providers) {
    if (RESERVED_PROVIDER_NAMES.has(provider.name)) {
      return `Provider name "${provider.name}" is reserved`;
    }
    if (!VALID_IDENTIFIER.test(provider.name)) {
      return `Provider name "${provider.name}" is not a valid JavaScript identifier`;
    }
    if (seenNames.has(provider.name)) {
      return `Duplicate provider name "${provider.name}"`;
    }
    seenNames.add(provider.name);
  }
  return undefined;
};

const INTERNAL_PROVIDER_NAMES = new Set(["__context"]);

const createScopedContextProxySource = () => String.raw`
    const __createScopedContextHandle = (scope) => new Proxy({}, {
      get: (_, namespace) => {
        if (typeof namespace !== "string") return undefined;
        return new Proxy({}, {
          get: (_, toolName) => {
            if (typeof toolName !== "string") return undefined;
            return async (...args) => {
              const resJson = await __dispatchers.__context.call("callScoped", __stringifyForCodemode([{ scope, namespace, toolName, args }]));
              const data = __parseForCodemode(resJson);
              if (data.error) throw new Error(data.error);
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
        if (data.error) throw new Error(data.error);
        return data.result;
      },
      get current() { return __createScopedContextHandle({ kind: "current" }); },
      org: (orgId) => __createScopedContextHandle({ kind: "org", orgId: String(orgId) }),
      user: (userId) => __createScopedContextHandle({ kind: "user", userId: String(userId) }),
      project: (projectId) => __createScopedContextHandle({ kind: "project", projectId: String(projectId) }),
    };`;

export const createCodemodeProviderProxySource = (providers: readonly ResolvedProvider[]): string =>
  [
    ...providers
      .filter((provider) => !INTERNAL_PROVIDER_NAMES.has(provider.name))
      .map(
        (provider) =>
          `    const ${provider.name} = new Proxy({}, {\n` +
          `      get: (_, toolName) => async (...args) => {\n` +
          `        const resJson = await __dispatchers.${provider.name}.call(String(toolName), __stringifyForCodemode(args));\n` +
          `        const data = __parseForCodemode(resJson);\n` +
          `        if (data.error) throw new Error(data.error);\n` +
          `        return data.result;\n` +
          `      }\n` +
          `    });`,
      ),
    ...(providers.some((provider) => provider.name === "__context")
      ? [createScopedContextProxySource()]
      : []),
  ].join("\n");

export const createCodemodeDispatchers = (
  providers: readonly ResolvedProvider[],
): { dispatchers: Record<string, ToolDispatcher> } | { error: string } => {
  const providerNameError = validateProviderNames(providers);
  if (providerNameError) {
    return { error: providerNameError };
  }

  const dispatchers: Record<string, ToolDispatcher> = {};

  for (const provider of providers) {
    const sanitizedFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const sanitizedNames = new Map<string, string>();

    for (const [name, fn] of Object.entries(provider.fns)) {
      const sanitizedName = sanitizeToolName(name);
      const existingName = sanitizedNames.get(sanitizedName);
      if (existingName && existingName !== name) {
        return {
          error:
            `Tool names "${existingName}" and "${name}" both sanitize to ` +
            `"${sanitizedName}" in provider "${provider.name}"`,
        };
      }
      sanitizedNames.set(sanitizedName, name);
      sanitizedFns[sanitizedName] = fn;
    }

    dispatchers[provider.name] = new ToolDispatcher(sanitizedFns);
  }

  return { dispatchers };
};

export type DynamicWorkerRpcTargetMap = Record<string, unknown>;

/** Preserves the disposable custom promise returned directly by a Cloudflare RPC call. */
export type DynamicWorkerRpcCall<TResult extends object> = Promise<TResult> & {
  [Symbol.dispose](): void;
};

export type DynamicWorkerEntrypointRunOptions<TEntrypoint, TResult extends object> = {
  bundle: WorkerBundle;
  globalOutbound?: Fetcher | null;
  rpcTargets?: DynamicWorkerRpcTargetMap;
  run: (
    entrypoint: TEntrypoint,
    rpcTargets: DynamicWorkerRpcTargetMap,
  ) => DynamicWorkerRpcCall<TResult>;
};

export class DynamicWorkerExecutor {
  readonly #loader: WorkerLoader;
  readonly #timeout: number;
  readonly #globalOutbound: Fetcher | null;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30000;
    this.#globalOutbound = options.globalOutbound ?? null;
  }

  async execute(
    bundle: WorkerBundle,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<ExecuteResult> {
    const providers = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: "codemode", fns: providersOrFns }];

    const dispatcherResult = createCodemodeDispatchers(providers);
    if ("error" in dispatcherResult) {
      return { result: undefined, error: dispatcherResult.error };
    }

    const response = await this.evaluateWorkerBundle(bundle, {
      __dispatchers: dispatcherResult.dispatchers,
    });

    if (response.error) {
      return {
        result: undefined,
        error: response.error,
        logs: response.logs,
        workflowDefinition: response.workflowDefinition,
      } as ExecuteResult;
    }

    return {
      result: response.result,
      logs: response.logs,
      workflowDefinition: response.workflowDefinition,
    } as ExecuteResult;
  }

  createExecutorModule(code: string, providers: readonly ResolvedProvider[]): string {
    return [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__rpcTargets = {}) {",
      "    const { __dispatchers = {} } = __rpcTargets;",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      CODEMODE_SANDBOX_CODEC_SOURCE,
      createCodemodeProviderProxySource(providers),
      "",
      "    try {",
      "      const program = (" + normalizeCode(code) + ");",
      "      const result = __isFragnoCodemodeWorkflowDefinition(program)",
      "        ? program",
      "        : await Promise.race([",
      '          typeof program === "function" ? program() : Promise.resolve(program),',
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${this.#timeout}))`,
      "        ]);",
      "      if (__isFragnoCodemodeWorkflowDefinition(result)) {",
      "        return { result: undefined, workflowDefinition: { name: String(result.options.name), options: result.options }, logs: __logs };",
      "      }",
      "      return { result, logs: __logs };",
      "    } catch (err) {",
      "      return { result: undefined, error: err.message, logs: __logs };",
      "    }",
      "  }",
      "}",
    ].join("\n");
  }

  async runEntrypoint<TEntrypoint, TResult extends object>({
    bundle,
    globalOutbound = this.#globalOutbound,
    rpcTargets = {},
    run,
  }: DynamicWorkerEntrypointRunOptions<TEntrypoint, TResult>): Promise<TResult> {
    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      mainModule: bundle.mainModule,
      modules: { ...bundle.modules },
      compatibilityDate: bundle.runtime.compatibilityDate,
      compatibilityFlags:
        bundle.runtime.compatibilityFlags.length > 0
          ? [...bundle.runtime.compatibilityFlags]
          : undefined,
      globalOutbound,
    }));

    const entrypoint = worker.getEntrypoint();
    try {
      const rpcResult = run(entrypoint as unknown as TEntrypoint, rpcTargets);
      try {
        return await rpcResult;
      } finally {
        // The in-memory WorkerLoader returns native promises; production RPC calls are disposable.
        (rpcResult as unknown as Partial<Disposable>)[Symbol.dispose]?.();
      }
    } finally {
      (entrypoint as unknown as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }

  async evaluateWorkerBundle(
    bundle: WorkerBundle,
    rpcTargets: DynamicWorkerRpcTargetMap,
  ): Promise<{
    result: unknown;
    error?: string;
    logs?: string[];
    workflowDefinition?: { name: string; options?: unknown };
  }> {
    return await this.runEntrypoint<
      {
        evaluate(rpcTargets: DynamicWorkerRpcTargetMap): DynamicWorkerRpcCall<{
          result: unknown;
          error?: string;
          logs?: string[];
          workflowDefinition?: { name: string; options?: unknown };
        }>;
      },
      {
        result: unknown;
        error?: string;
        logs?: string[];
        workflowDefinition?: { name: string; options?: unknown };
      }
    >({
      bundle,
      rpcTargets,
      run: (entrypoint, targets) => entrypoint.evaluate(targets),
    });
  }
}
