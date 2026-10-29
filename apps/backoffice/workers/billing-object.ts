import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { RpcTarget } from "cloudflare:workers";

import type { BackofficeHostTelemetry } from "@/backoffice-runtime/backoffice-telemetry";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type BackofficeRpcContext,
  type BillingCommands,
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
import type {
  UsageLimitSetting,
  UsageLimitedMeter,
  UsageLimits,
} from "@/fragno/billing/usage-limits";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

type BillingOwnerScope = Extract<BackofficeContextScope, { kind: "org" | "user" }>;

export class BillingObject extends RpcTarget implements BillingCommands {
  readonly #host: FragmentDurableObjectHost<void, BillingFragment>;
  readonly #ownerScope: BillingOwnerScope;
  readonly #nowEpochMs: () => number;
  readonly #telemetry: BackofficeHostTelemetry;
  #fragment: BillingFragment | null = null;

  constructor({
    state,
    implementation,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    nowEpochMs: () => number;
  }) {
    super();
    this.#nowEpochMs = nowEpochMs;
    const ownerScope = requireBackofficeContextScopeFromDurableObjectId(state.id, "BILLING");
    if (ownerScope.kind !== "org" && ownerScope.kind !== "user") {
      throw new Error("Billing objects require an organization or user scope.");
    }
    this.#ownerScope = ownerScope;
    this.#telemetry = implementation.hostTelemetry("Billing");
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

  async warm(): Promise<void> {}

  async recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult> {
    const fragment = this.#getFragment();
    const { period, reachedLimits, ...result } = await fragment.callServices(
      () => fragment.services.recordEvent(input),
      context,
    );
    for (const status of reachedLimits) {
      this.#telemetry.record({ kind: "usage-limit-reached", period, status });
    }
    return result;
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

  async getUsageLimits(): Promise<UsageLimits> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() =>
      fragment.services.getUsageLimits({ period: this.#currentPeriod() }),
    );
  }

  async setUsageLimit(input: {
    meter: UsageLimitedMeter;
    setting: UsageLimitSetting;
  }): Promise<UsageLimits> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() =>
      fragment.services.setUsageLimit({ ...input, period: this.#currentPeriod() }),
    );
  }

  /** Producers record usage by the clock they share with this object, so limits read the same month. */
  #currentPeriod(): string {
    return new Date(this.#nowEpochMs()).toISOString().slice(0, 7);
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}
