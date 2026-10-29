import { DurableObject } from "cloudflare:workers";

import type { GitHubCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { GitHubObject } from "./github-object";

export class GitHub extends DurableObject<CloudflareEnv> implements GitHubCommands {
  #object!: GitHubObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { GitHubObject } = await import("./github-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new GitHubObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async ensureAdminConfig() {
    await this.#object.ensureAdminConfig();
  }

  async alarm() {
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

  async redeliverFailedInstallationWebhooks(installationId: string): Promise<void> {
    await this.#object.redeliverFailedInstallationWebhooks(installationId);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
