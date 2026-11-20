import {
  type BackofficeContextScope,
  type BackofficeScopeIdNames,
  backofficeContextScopeSchema,
  backofficeContextScopesEqual,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import type { OverrideAddress, OverridesCommands } from "@/fragno/overrides/definition";
import { createOverridesServer } from "@/fragno/overrides/fragment";
import { overrideScopeChain, overrideStoreScope } from "@/fragno/overrides/resolve";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

const overrideAddressRpcInput = z.strictObject({
  scope: backofficeContextScopeSchema,
  kind: z.enum(["feature-flag", "entitlement"]),
  key: z.string().min(1),
});

/** Keeps the overrides of the scopes a root owner owns, or the system's own. */
export class OverridesObject extends RpcTarget implements OverridesCommands {
  readonly #scope: BackofficeContextScope;
  #fragment: ReturnType<typeof createOverridesServer> | null = null;

  constructor({
    state,
    implementation,
  }: {
    state: BackofficeObjectState;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    this.#scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "OVERRIDES");
    const host = implementation.createFragmentHost<void, ReturnType<typeof createOverridesServer>>({
      name: "Overrides",
      createRuntime: () => createOverridesServer(implementation.fragmentDatabase),
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await host.initialize(undefined);
    });
  }

  #getFragment() {
    if (!this.#fragment) {
      throw new Error("Overrides are unavailable.");
    }
    return this.#fragment;
  }

  #keeps(scope: BackofficeContextScope) {
    return backofficeContextScopesEqual(overrideStoreScope(scope), this.#scope);
  }

  /** Values stay opaque here; their definitions check them when set and when read. */
  #storedAddress(input: OverrideAddress) {
    const { scope, ...address } = overrideAddressRpcInput.parse(input);
    if (!this.#keeps(scope)) {
      throw new Error("Overrides are kept by their scope's root owner.");
    }
    return { scope: backofficeScopePathSegment(scope), ...address };
  }

  async listOverrides(input: BackofficeContextScope) {
    const kept = overrideScopeChain<BackofficeScopeIdNames>(
      backofficeContextScopeSchema.parse(input),
    ).filter((scope) => this.#keeps(scope));
    if (kept.length === 0) {
      throw new Error("This overrides object keeps no overrides on the scope's chain.");
    }
    const fragment = this.#getFragment();
    return await fragment.callServices(() =>
      fragment.services.listOverrides(kept.map(backofficeScopePathSegment)),
    );
  }

  async setOverride({ value, ...address }: OverrideAddress & { value: unknown }) {
    const stored = this.#storedAddress(address);
    const fragment = this.#getFragment();
    await fragment.callServices(() => fragment.services.setOverride({ ...stored, value }));
  }

  async clearOverride(address: OverrideAddress) {
    const stored = this.#storedAddress(address);
    const fragment = this.#getFragment();
    await fragment.callServices(() => fragment.services.clearOverride(stored));
  }
}
