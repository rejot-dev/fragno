import { DurableObject } from "cloudflare:workers";

import type { CloudflareCommands } from "@/backoffice-runtime/object-registry";

import type { CloudflareObject } from "./cloudflare-object";

export class Cloudflare extends DurableObject<CloudflareEnv> implements CloudflareCommands {
  #object!: CloudflareObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { CloudflareObject } = await import("./cloudflare-object");
      const { createCloudflareDurableObjectRuntimeServices } =
        await import("@/backoffice-runtime/runtime-services");
      this.#object = new CloudflareObject({
        state,
        env,
        runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
