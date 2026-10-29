import { DurableObject } from "cloudflare:workers";

import type { ApiCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { ApiObject } from "./api-object";

export class Api extends DurableObject<CloudflareEnv> implements ApiCommands {
  #object!: ApiObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { ApiObject } = await import("./api-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new ApiObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async warm(): Promise<void> {
    await this.#object.warm();
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
