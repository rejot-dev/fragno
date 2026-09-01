import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type BackofficeRpcContext,
  type BillingObject,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type {
  BillingEventInput,
  BillingFragment,
  BillingRecordEventResult,
  BillingStatement,
  BillingStatementInput,
  BillingTrackerPage,
  BillingTrackerPageInput,
} from "@/fragno/billing";
import { createBillingServer } from "@/fragno/billing/billing";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDatabaseTransactionInstrumentation } from "./lib/cloudflare-database-transaction-instrumentation";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";

type BillingOwnerScope = Extract<BackofficeContextScope, { kind: "org" }>;

export class InMemoryBillingObject extends RpcTarget implements BillingObject {
  readonly #host: FragmentDurableObjectHost<void, BillingFragment>;
  readonly #ownerScope: BillingOwnerScope;
  #fragment: BillingFragment | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    const ownerScope = requireBackofficeContextScopeFromDurableObjectId(state.id, "BILLING");
    if (ownerScope.kind !== "org") {
      throw new Error("Billing objects require an organization scope.");
    }
    this.#ownerScope = ownerScope;
    this.#host = createFragmentDurableObjectHost({
      name: "Billing",
      state,
      env,
      createRuntime: () =>
        createBillingServer({
          adapters: runtime.adapters,
          transactionInstrumentation: cloudflareDatabaseTransactionInstrumentation,
        }),
      durableHooksInstrumentation: cloudflareDurableHooksInstrumentation,
      onProcessError: (error) => {
        console.error("Billing hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Billing hook dispatcher initialization failed", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): BillingFragment {
    if (!this.#fragment) {
      throw new Error("Billing is unavailable.");
    }
    return this.#fragment;
  }

  #requireOwnerScope(): BillingOwnerScope {
    return this.#ownerScope;
  }

  async recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.recordEvent(input), context);
  }

  async getStatement(input: BillingStatementInput): Promise<BillingStatement> {
    this.#requireOwnerScope();
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getStatement(input));
  }

  async getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getTrackers(input));
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

export class Billing extends DurableObject<CloudflareEnv> implements BillingObject {
  readonly #object: InMemoryBillingObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryBillingObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult> {
    return await this.#object.recordEvent(input, context);
  }

  async getStatement(input: BillingStatementInput): Promise<BillingStatement> {
    return await this.#object.getStatement(input);
  }

  async getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage> {
    return await this.#object.getTrackers(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
