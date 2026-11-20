import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type { OverrideAddress, OverridesCommands } from "@/fragno/overrides/definition";

import type { OverridesObject } from "./overrides-object";

export class Overrides extends DurableObject<CloudflareEnv> implements OverridesCommands {
  #object!: OverridesObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { OverridesObject } = await import("./overrides-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new OverridesObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async listOverrides(scope: BackofficeContextScope) {
    return await this.#object.listOverrides(scope);
  }

  async setOverride(input: OverrideAddress & { value: unknown }) {
    await this.#object.setOverride(input);
  }

  async clearOverride(input: OverrideAddress) {
    await this.#object.clearOverride(input);
  }
}
