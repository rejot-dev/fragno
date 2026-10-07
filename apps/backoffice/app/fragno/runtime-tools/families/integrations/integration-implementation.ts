import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { JsonValue } from "@/lib/zod/json-value";

import type {
  IntegrationAction,
  IntegrationConnection,
  IntegrationConnectionPage,
  IntegrationDisconnectResult,
  IntegrationInspection,
  IntegrationOverview,
  IntegrationSetupProgress,
  IntegrationSetupOperation,
} from "./integration-contracts";

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
   * are null. Publishing an action definition never authorizes its invocation.
   */
  invoke(input: JsonValue): Promise<JsonValue>;
}

/** Resolution binds authority without forcing configuration inspection or a live check before every action. */
export interface ResolvedIntegrationConnection {
  readonly identity: Pick<IntegrationConnection, "connectionId" | "integrationId" | "name">;
  inspect(): Promise<IntegrationInspection>;
  actions(): Promise<readonly IntegrationActionImplementation[]>;
  verify(): Promise<IntegrationInspection>;
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
  list(context: IntegrationContext, cursor: string | null): Promise<IntegrationConnectionPage>;
  resolve(context: IntegrationContext, localId: string): Promise<ResolvedIntegrationConnection>;
}
