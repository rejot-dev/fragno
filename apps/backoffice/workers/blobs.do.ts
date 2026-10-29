import { DurableObject } from "cloudflare:workers";

import type { BlobsCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { BlobsObject } from "./blobs-object";

export class Blobs extends DurableObject<CloudflareEnv> implements BlobsCommands {
  #object!: BlobsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { BlobsObject } = await import("./blobs-object");
      const { blobsR2BucketsFromEnv } = await import("@/fragno/blobs-server");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      const buckets = blobsR2BucketsFromEnv(
        env,
        env.DURABLE_OBJECT_JURISDICTIONS === "local" ? "local" : "enforced",
      );
      this.#object = new BlobsObject({
        ...createCloudflareBackofficeObjectContext(state, env),
        storage: buckets ? { buckets, fetch } : null,
      });
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
