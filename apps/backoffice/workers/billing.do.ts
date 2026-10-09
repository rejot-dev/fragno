import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  requireBackofficeContextScopeFromDurableObjectId,
  type BackofficeRpcContext,
  type BillingObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
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
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

type BillingOwnerScope = Extract<BackofficeContextScope, { kind: "org" }>;

export class InMemoryBillingObject extends RpcTarget implements BillingObject {
  readonly #host: FragmentDurableObjectHost<void, BillingFragment>;
  readonly #ownerScope: BillingOwnerScope;
  #fragment: BillingFragment | null = null;

  constructor({
    state,
    implementation,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    const ownerScope = requireBackofficeContextScopeFromDurableObjectId(state.id, "BILLING");
    if (ownerScope.kind !== "org") {
      throw new Error("Billing objects require an organization scope.");
    }
    this.#ownerScope = ownerScope;
    this.#host = implementation.createFragmentHost({
      name: "Billing",
      createRuntime: () => createBillingServer(implementation.fragmentDatabase),
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
    this.#object = new InMemoryBillingObject(createCloudflareBackofficeObjectContext(state, env));
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
