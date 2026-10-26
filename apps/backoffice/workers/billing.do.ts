import { DurableObject } from "cloudflare:workers";

import type { BillingCommands, BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import type {
  BillingEventInput,
  BillingRecordEventResult,
  BillingStatementInput,
  BillingStatement,
  BillingTrackerPageInput,
  BillingTrackerPage,
} from "@/fragno/billing";

import type { BillingObject } from "./billing-object";

export class Billing extends DurableObject<CloudflareEnv> implements BillingCommands {
  #object!: BillingObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { BillingObject } = await import("./billing-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new BillingObject(createCloudflareBackofficeObjectContext(state, env));
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
