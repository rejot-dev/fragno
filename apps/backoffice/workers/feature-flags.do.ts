import { DurableObject } from "cloudflare:workers";

import type { FeatureFlagKey, FeatureFlagsCommands } from "@/fragno/feature-flags/contracts";

import type { FeatureFlagsObject } from "./feature-flags-object";

export class FeatureFlags extends DurableObject<CloudflareEnv> implements FeatureFlagsCommands {
  #object!: FeatureFlagsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    void state.blockConcurrencyWhile(async () => {
      const { FeatureFlagsObject } = await import("./feature-flags-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new FeatureFlagsObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async getFlag(key: FeatureFlagKey) {
    return await this.#object.getFlag(key);
  }

  async listFlags() {
    return await this.#object.listFlags();
  }

  async setFlag(input: Parameters<FeatureFlagsCommands["setFlag"]>[0]) {
    return await this.#object.setFlag(input);
  }
}
