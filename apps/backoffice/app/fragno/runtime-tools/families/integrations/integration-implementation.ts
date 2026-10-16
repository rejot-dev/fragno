import type { ApiAuthStatus, ApiConnection, WebhookEndpoint } from "@fragno-dev/api-fragment/types";
import type {
  IntegrationAuthMethod,
  IntegrationAction,
  IntegrationConnection,
  IntegrationConnectionPage,
  IntegrationConnectionSettings,
  IntegrationDisconnectResult,
  IntegrationInspection,
  IntegrationOverview,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import type { McpAuthStatus, McpTool } from "@fragno-dev/mcp-fragment/types";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

import type { IntegrationSetupOperation } from "./integration-contracts";
import type { IntegrationConnectionState } from "./integration-events";

/** Implementations receive established execution authority, never caller-selected ownership. */
export type IntegrationContext = {
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
};

/** Exact names can share a namespace; a namespace claim owns all of its source-local addresses. */
export type IntegrationConnectionIdClaim =
  | { kind: "exact"; connectionId: string }
  | { kind: "namespace"; namespace: string };

/** Action handlers capture the resolved connection and authority for this request, not a retained handle. */
export interface IntegrationActionImplementation {
  readonly definition: IntegrationAction;

  /**
   * Validate against the live input/output contracts and enforce action-specific authorization.
   * The tool establishes JSON representability, not action shape. Binary inputs are schema-declared
   * byte arrays converted privately; native objects never cross the public API. No-payload results
   * are null. Publishing an action definition never authorizes its invocation. Unchecked actions
   * skip validation; the facade runs them only when the caller opts in.
   */
  invoke(input: JsonValue): Promise<JsonValue>;
}

/**
 * Every Object activation evaluates the integration modules, so a checked action converts its
 * contracts to JSON Schema when it is first listed or invoked, then reuses that definition.
 */
export function checkedIntegrationActionDefinition(action: {
  id: string;
  label: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
}): () => IntegrationAction {
  let definition: IntegrationAction | null = null;
  return () =>
    (definition ??= {
      id: action.id,
      label: action.label,
      description: action.description,
      validation: { kind: "checked" },
      inputSchema: z.toJSONSchema(action.input, { io: "input" }),
      outputSchema: z.toJSONSchema(action.output, { io: "output" }),
    });
}

/**
 * Source-owned facts Backoffice's read-only connection views show beside the inspection. Values
 * come from the sources' sanitized reads, so they never contain secrets. Null means the source has
 * nothing stored at the address.
 */
export type IntegrationConnectionDetails =
  | { kind: "api"; connection: ApiConnection | null; authStatus: ApiAuthStatus | null }
  | { kind: "webhook"; endpoint: WebhookEndpoint | null; publicUrl: string | null }
  | {
      kind: "mcp";
      server: { endpointUrl: string; tools: McpTool[] | null } | null;
      authStatus: McpAuthStatus | null;
    }
  | {
      kind: "connector";
      projectId: string;
      providerConfigId: string;
      connectionName: string;
      accountId: string | null;
    }
  // Native services are managed on their own Backoffice pages.
  | { kind: "native" };

/** Resolution binds authority without forcing configuration inspection or a live check before every action. */
export interface ResolvedIntegrationConnection {
  readonly identity: Pick<
    IntegrationConnection,
    "connectionId" | "integrationId" | "name" | "authMethod"
  >;
  inspect(): Promise<IntegrationInspection>;
  /** The state this source's integrations.connection.* events report for the connection now. */
  state(): Promise<IntegrationConnectionState>;
  details(): Promise<IntegrationConnectionDetails>;
  settings(): Promise<IntegrationConnectionSettings>;
  actions(): Promise<readonly IntegrationActionImplementation[]>;
  verify(): Promise<IntegrationInspection>;
}

/** The API and MCP Fragments store the same auth mode names. */
export function authMethodOfFragmentAuthMode(authMode: string): IntegrationAuthMethod {
  switch (authMode) {
    case "none":
    case "bearer":
    case "basic":
    case "oauth":
      return authMode;
    case "client_credentials":
      return "client-credentials";
    default:
      throw new Error(`Fragment auth mode '${authMode}' is unsupported.`);
  }
}

/** Lifecycle support is explicit; private state and validation schemas stay with the owning source. */
export type IntegrationCapability<TRun> =
  | { kind: "unsupported"; reason: string }
  | { kind: "supported"; run: TRun };

type IntegrationProgressRun = (
  context: IntegrationContext,
  input: { localId: string; operation: IntegrationSetupOperation },
) => Promise<IntegrationSetupProgress>;

/** A scoped connection source can expose several services without allocating facade-owned bindings. */
export interface IntegrationImplementation {
  readonly connectionIds: readonly IntegrationConnectionIdClaim[];
  /** Brings an address to ready without replacing stored configuration or credentials. */
  readonly setup: IntegrationCapability<IntegrationProgressRun>;
  /** Replaces an existing connection's configuration or credentials; a missing one needs setup. */
  readonly reconfigure: IntegrationCapability<IntegrationProgressRun>;
  /** Removes source-owned configuration and credentials; the address remains valid for setup. */
  readonly disconnect: IntegrationCapability<
    (
      context: IntegrationContext,
      input: { localId: string },
    ) => Promise<IntegrationDisconnectResult>
  >;

  discover(context: IntegrationContext): Promise<readonly IntegrationOverview[]>;
  /** Lists only this source's connections; the registry reports sources that fail to list. */
  list(
    context: IntegrationContext,
    cursor: string | null,
  ): Promise<Omit<IntegrationConnectionPage, "unavailableSources">>;
  resolve(context: IntegrationContext, localId: string): Promise<ResolvedIntegrationConnection>;
}
