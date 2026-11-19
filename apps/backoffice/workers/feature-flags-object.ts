import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import {
  featureFlagKeySchema,
  type FeatureFlagKey,
  type FeatureFlagsCommands,
} from "@/fragno/feature-flags/contracts";
import { createFeatureFlagsServer } from "@/fragno/feature-flags/fragment";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

const setFeatureFlagRpcInput = z.strictObject({
  key: featureFlagKeySchema,
  override: z.boolean().nullable(),
});

export class FeatureFlagsObject extends RpcTarget implements FeatureFlagsCommands {
  #fragment: ReturnType<typeof createFeatureFlagsServer> | null = null;

  constructor({
    state,
    implementation,
  }: {
    state: BackofficeObjectState;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    requireBackofficeContextScopeFromDurableObjectId(state.id, "FEATURE_FLAGS");
    const host = implementation.createFragmentHost<
      void,
      ReturnType<typeof createFeatureFlagsServer>
    >({
      name: "FeatureFlags",
      createRuntime: () => createFeatureFlagsServer(implementation.fragmentDatabase),
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await host.initialize(undefined);
    });
  }

  #getFragment() {
    if (!this.#fragment) {
      throw new Error("Feature flags are unavailable.");
    }
    return this.#fragment;
  }

  async getFlag(key: FeatureFlagKey) {
    const flag = featureFlagKeySchema.parse(key);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getFlag(flag));
  }

  async listFlags() {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listFlags());
  }

  async setFlag(input: Parameters<FeatureFlagsCommands["setFlag"]>[0]) {
    const setting = setFeatureFlagRpcInput.parse(input);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.setFlag(setting));
  }
}
