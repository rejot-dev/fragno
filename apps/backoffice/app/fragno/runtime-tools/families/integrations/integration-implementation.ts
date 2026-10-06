import type { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { JsonValue } from "@/lib/zod/json-value";

import type {
  IntegrationAction,
  IntegrationInspection,
  IntegrationOverview,
  IntegrationSetupProgress,
  IntegrationSetupResponse,
} from "./integration-contracts";

/** Integration implementations receive established execution authority, not caller-selected ownership. */
export type IntegrationContext = {
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
};

type IntegrationSetupStage<TStatus extends IntegrationSetupProgress["status"]> = Omit<
  Extract<IntegrationSetupProgress, { status: TStatus }>,
  "setupId"
>;

/** Integration setup steps reuse public requirements but replace public handles with private typed state. */
export type IntegrationSetupStep<TSetupState, TBinding> =
  | (IntegrationSetupStage<"needs-input"> & { state: TSetupState })
  | (IntegrationSetupStage<"needs-authorization"> & { state: TSetupState })
  | (IntegrationSetupStage<"pending"> & { state: TSetupState })
  | (Omit<IntegrationSetupStage<"ready">, "reference"> & { binding: TBinding })
  | IntegrationSetupStage<"blocked">
  | IntegrationSetupStage<"expired">;

/** Integration actions expose one authoritative definition and an invocation boundary, never a second dispatcher. */
export interface IntegrationActionImplementation {
  readonly definition: IntegrationAction;

  /**
   * Validate untrusted input against the definition's live contract and enforce action-specific
   * authorization before service side effects. JSON representability is established by the tool;
   * action-specific shape is not. Binary fields are schema-declared integer byte arrays (0–255),
   * converted to native buffers only inside the implementation. Native objects never cross this API.
   * Validate and encode service results as JSON matching the published output contract, including
   * asynchronous semantics; a result with no payload is null. Discovery never authorizes invocation.
   */
  invoke(context: IntegrationContext, input: JsonValue): Promise<JsonValue>;
}

/**
 * Interface sketch for one service integration, regardless of its private connection mechanism.
 * Not a backend implementation: the registry, handle storage, and dispatch runtime remain deferred.
 * A factory may produce multiple implementations, such as Slack and Gmail through one Connector.
 */
export interface IntegrationImplementation<TSetupState, TBinding> {
  /** Validate private continuation data when the runtime loads a retained setup attempt. */
  readonly setupStateSchema: z.ZodType<TSetupState>;
  /** Validate private binding data when the runtime resolves a scope-owned public reference. */
  readonly bindingSchema: z.ZodType<TBinding>;

  /** Declare scoped connection cardinality; singleton configuration remains owned by its existing store. */
  describe(context: IntegrationContext): Promise<IntegrationOverview>;

  /**
   * Called only after the runtime reserves a new binding/setup slot. For singleton services, that
   * slot is unique by integration ID and owner scope. An existing binding returns its ready progress;
   * a nonterminal attempt returns its current progress. Neither calls this method again, changes its
   * name, nor replaces credentials. Multiple-cardinality services reserve a new slot for each connect.
   * Singleton bindings point to existing scoped configuration; names never create credential copies.
   */
  connect(
    context: IntegrationContext,
    input: { name: string },
  ): Promise<IntegrationSetupStep<TSetupState, TBinding>>;

  /**
   * The runtime supplies previously retained state after verifying the attempt's owner. Interpret
   * responses only for the current requirement; a check reads authoritative consent or installation
   * state, not a user assertion. Terminal blocked or expired attempts do not restart silently.
   */
  continueSetup(
    context: IntegrationContext,
    state: TSetupState,
    response: IntegrationSetupResponse,
  ): Promise<IntegrationSetupStep<TSetupState, TBinding>>;

  /** Read saved state and existing evidence without performing new service checks. */
  inspect(context: IntegrationContext, binding: TBinding): Promise<IntegrationInspection>;

  /**
   * Return only supported actions with real authoritative contracts. Handlers capture the selected
   * private binding; the runtime publishes their definitions and resolves an action ID to invoke.
   * Action handlers are execution-time objects, not retained setup state or public tool results.
   */
  actions(
    context: IntegrationContext,
    binding: TBinding,
  ): Promise<readonly IntegrationActionImplementation[]>;

  /** Perform supported checks without authorizing the binding or executing service actions. */
  verify(context: IntegrationContext, binding: TBinding): Promise<IntegrationInspection>;

  /**
   * Release only resources owned by this binding. The runtime disables its public reference;
   * shared credentials and external service data are not implicitly revoked or deleted. Singleton
   * disconnect frees the runtime's slot but preserves its underlying scoped configuration, including
   * access by legacy service tools. Reconnect may reuse that configuration behind a new reference.
   */
  disconnect(context: IntegrationContext, binding: TBinding): Promise<void>;
}
