import { DurableObject } from "cloudflare:workers";

import type { UploadCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { UploadObject } from "./upload-object";

export class Upload extends DurableObject<CloudflareEnv> implements UploadCommands {
  #object!: UploadObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { UploadObject } = await import("./upload-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new UploadObject(createCloudflareBackofficeObjectContext(state, env));
    });
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

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
