import { DurableObject } from "cloudflare:workers";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { ResendCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { ResendObject, ConfigResponse, ResendConfigScope } from "./resend-object";

export class Resend extends DurableObject<CloudflareEnv> implements ResendCommands {
  #object!: ResendObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { ResendObject } = await import("./resend-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new ResendObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(
    payload: unknown,
    scope: ResendConfigScope,
    origin: string,
  ): Promise<ConfigResponse> {
    return await this.#object.setAdminConfig(payload, scope, origin);
  }

  async queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string; senderName: string | null },
  ): Promise<void> {
    await this.#object.queueEmail(input, options);
  }

  async checkWebhook() {
    return await this.#object.checkWebhook();
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#object.getDurableHookQueue(options);
  }

  async getDurableHook(hookId: string) {
    return await this.#object.getDurableHook(hookId);
  }

  async wakeDurableHooks() {
    await this.#object.wakeDurableHooks();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
