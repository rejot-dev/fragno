import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel, type BackofficeScopeOperation } from "@/backoffice-runtime/kernel";
import type { BackofficeRpcContext, BillingObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type {
  BillingEventInput,
  BillingFragment,
  BillingRecordEventResult,
  BillingTrackerPage,
  BillingTrackerPageInput,
} from "@/fragno/billing";
import { createBillingServer } from "@/fragno/billing/billing";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

type BillingOwnerScope = Extract<BackofficeContextScope, { kind: "org" }>;

export class InMemoryBillingObject extends RpcTarget implements BillingObject {
  readonly #state: BackofficeObjectState;
  readonly #kernel: BackofficeKernel;
  readonly #host: FragmentDurableObjectHost<void, BillingFragment>;
  #fragment: BillingFragment | null = null;
  #ownerScope: BillingOwnerScope | null = null;

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
    this.#state = state;
    this.#kernel = new BackofficeKernel({ objects: runtime.objects });
    this.#host = createFragmentDurableObjectHost({
      name: "Billing",
      state,
      env,
      createRuntime: () => createBillingServer({ adapters: runtime.adapters }),
      onProcessError: (error) => {
        console.error("Billing hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Billing hook processor disabled", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  init(scope: BackofficeContextScope): BillingObject {
    if (scope.kind !== "org") {
      throw new Error("Billing objects require an organization scope.");
    }
    if (this.#ownerScope && !backofficeContextScopesEqual(this.#ownerScope, scope)) {
      throw new Error("Billing object scope does not match object address scope.");
    }

    this.#ownerScope = scope;
    return this;
  }

  #getFragment(): BillingFragment {
    if (!this.#fragment) {
      throw new Error("Billing is unavailable.");
    }
    return this.#fragment;
  }

  #requireOwnerScope(): BillingOwnerScope {
    if (!this.#ownerScope) {
      throw new Error("Billing object has not been initialized with organization scope metadata.");
    }
    return this.#ownerScope;
  }

  async #assertScopeAllowed(
    scope: BackofficeContextScope,
    operation: BackofficeScopeOperation,
  ): Promise<void> {
    await this.#kernel.assertScopeAllowedByOwner({
      ownerScope: this.#requireOwnerScope(),
      targetScope: scope,
      operation,
    });
  }

  async recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult> {
    await this.#assertScopeAllowed(input.scope, "billing.record-event");
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.recordEvent(input), context);
  }

  async getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage> {
    await this.#assertScopeAllowed(input.scope, "billing.read-trackers");
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getTrackers(input));
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
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

  init(scope: BackofficeContextScope): BillingObject {
    return this.#object.init(scope);
  }

  async recordEvent(input: BillingEventInput): Promise<BillingRecordEventResult> {
    return await this.#object.recordEvent(input);
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
