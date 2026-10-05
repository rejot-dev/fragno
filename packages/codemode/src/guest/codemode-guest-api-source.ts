import type { ResolvedProvider } from "../runtime-api";

/**
 * Guest runtime adapted from agents/packages/codemode/src/executor.ts on 2026-06-05.
 * Source repository HEAD: d6827ab03fa703058e755d17e3f5db0cd90c94b6
 * Source file last-changed commit: f739ec9cd74c73da6a2d68403ab05f20940e36af
 * Source generation has no Worker Loader or Cloudflare RPC runtime dependency.
 */

/** Shared workflow definitions and domain error restoration; RPC transports own value serialization. */
export const CODEMODE_GUEST_API_SOURCE = String.raw`
const __FRAGNO_CODEMODE_WORKFLOW_TAG = "__fragno_codemode_workflow_v1__";
function __codemodeCallbackFailure(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const message = typeof error?.message === "string" ? error.message : String(error);
  const details = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 && typeof error?.code === "string"
    ? { status: error.status, code: error.code.slice(0, 1024) } : null;
  return { status: "error", error: {
    kind: name === "NonRetryableError" ? "non-retryable" : name === "WaitForEventTimeoutError" ? "event-timeout" : name === "CodemodeInterruptedError" ? "interrupted" : "error",
    name: name.slice(0, 1024), message: message.slice(0, 32768), details,
  } };
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

/** Internal providers expose the scoped context API instead of raw dispatcher globals. */
export const CODEMODE_INTERNAL_PROVIDER_NAMES: ReadonlySet<string> = new Set(["__context"]);

function createScopedContextProxySource(): string {
  return String.raw`
    const __createScopedContextHandle = (scope) => new Proxy({}, {
      get: (_, namespace) => {
        if (typeof namespace !== "string") return undefined;
        return new Proxy({}, {
          get: (_, toolName) => {
            if (typeof toolName !== "string") return undefined;
            return async (...args) => {
              const data = await __dispatchers.__context.call("callScoped", [{ scope, namespace, toolName, args }]);
              if (data.status === "error") __throwCodemodeProviderError(data.error);
              return data.value;
            };
          }
        });
      }
    });
    const context = {
      getCurrentScope: async () => {
        const data = await __dispatchers.__context.call("getCurrentScope", []);
        if (data.status === "error") __throwCodemodeProviderError(data.error);
        return data.value;
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
      .filter((provider) => !CODEMODE_INTERNAL_PROVIDER_NAMES.has(provider.name))
      .map(
        (provider) =>
          `    const ${provider.name} = new Proxy({}, {\n` +
          `      get: (_, toolName) => async (...args) => {\n` +
          `        const data = await __dispatchers.${provider.name}.call(String(toolName), args);\n` +
          `        if (data.status === "error") __throwCodemodeProviderError(data.error);\n` +
          `        return data.value;\n` +
          `      }\n` +
          `    });`,
      ),
    ...(providers.some((provider) => provider.name === "__context")
      ? [createScopedContextProxySource()]
      : []),
  ].join("\n");
}
