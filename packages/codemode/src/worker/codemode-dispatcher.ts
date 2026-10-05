import { RpcTarget } from "cloudflare:workers";

import {
  parseCodemodeValue,
  sanitizeToolName,
  stringifyCodemodeValue,
  type ResolvedProvider,
} from "../runtime-api";
import { encodeCodemodeError } from "../transport/codemode-errors";

const RESERVED_PROVIDER_NAMES = new Set([
  "context",
  "__createScopedContextHandle",
  "__rpcTargets",
  "__dispatchers",
  "__logs",
  "__logBytes",
  "__captureLog",
  "__CODEMODE_BINARY_TAG",
  "__bytesToBase64",
  "__base64ToBytes",
  "__encodeCodemodeValue",
  "__decodeCodemodeValue",
  "__stringifyForCodemode",
  "__parseForCodemode",
  "__throwCodemodeProviderError",
  "__FRAGNO_CODEMODE_WORKFLOW_TAG",
  "defineWorkflow",
  "__isFragnoCodemodeWorkflowDefinition",
  "RpcTarget",
  "WorkerEntrypoint",
  "AsyncLocalStorage",
  "logs",
  "logBytes",
  "captureLog",
  "workflowProgram",
  "suspensionKey",
  "isSuspension",
  "unwrap",
  "unsupported",
  "createRemoteWorkflowStep",
  "RemoteWorkflowEntrypoint",
]);

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function validateProviderNames(providers: readonly ResolvedProvider[]): string | undefined {
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
}

/** Exposes only own, explicitly registered provider functions to the guest. */
export class ToolDispatcher extends RpcTarget {
  readonly #fns: Record<string, (...args: unknown[]) => unknown>;

  constructor(fns: Record<string, (...args: unknown[]) => unknown>) {
    super();
    this.#fns = fns;
  }

  async call(toolName: string, argsJson: string): Promise<string> {
    if (!Object.hasOwn(this.#fns, toolName)) {
      return stringifyCodemodeValue({
        error: encodeCodemodeError(new Error(`Unknown tool: ${toolName}`)),
      });
    }
    try {
      const args = parseCodemodeValue(argsJson);
      if (!Array.isArray(args)) {
        throw new Error("CODEMODE_TOOL_ARGUMENTS_MUST_BE_ARRAY");
      }
      return stringifyCodemodeValue({ result: await this.#fns[toolName](...(args as unknown[])) });
    } catch (error) {
      return stringifyCodemodeValue({ error: encodeCodemodeError(error) });
    }
  }
}

/** Rejects conflicting guest names before exposing provider functions as Cloudflare RPC targets. */
export function createCodemodeDispatchers(
  providers: readonly ResolvedProvider[],
): { dispatchers: Record<string, ToolDispatcher> } | { error: string } {
  const providerNameError = validateProviderNames(providers);
  if (providerNameError) {
    return { error: providerNameError };
  }

  const dispatchers = new Map<string, ToolDispatcher>();

  for (const provider of providers) {
    const sanitizedFns: Record<string, (...args: unknown[]) => Promise<unknown>> =
      Object.create(null);
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

    dispatchers.set(provider.name, new ToolDispatcher(sanitizedFns));
  }

  // Cloudflare RPC requires plain-object dictionaries; fromEntries also preserves __proto__ as data.
  return { dispatchers: Object.fromEntries(dispatchers) };
}
