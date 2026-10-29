import { DurableObject } from "cloudflare:workers";

import type { TelegramCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { TelegramObject } from "./telegram-object";

export class Telegram extends DurableObject<CloudflareEnv> implements TelegramCommands {
  #object!: TelegramObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { TelegramObject } = await import("./telegram-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new TelegramObject({
        ...createCloudflareBackofficeObjectContext(state, env),
        nowEpochMs: Date.now,
      });
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getAdminConfig() {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig() {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(input: unknown) {
    return await this.#object.setAdminConfig(input);
  }

  async getAutomationFile(input: { fileId: string }) {
    return await this.#object.getAutomationFile(input);
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
