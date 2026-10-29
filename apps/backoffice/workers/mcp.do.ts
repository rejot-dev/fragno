import { DurableObject } from "cloudflare:workers";

import type { McpCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { McpObject } from "./mcp-object";

export class Mcp extends DurableObject<CloudflareEnv> implements McpCommands {
  #object!: McpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { McpObject } = await import("./mcp-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new McpObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
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
