import { DurableObject } from "cloudflare:workers";

import type { PresenceCommands } from "@/backoffice-runtime/object-registry";
import type {
  PresenceActivity,
  PresenceActivityResult,
  PresenceMember,
} from "@/presence/contracts";

import type { PresenceObject } from "./presence-object";

export class Presence extends DurableObject<CloudflareEnv> implements PresenceCommands {
  #object!: PresenceObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { PresenceObject } = await import("./presence-object");
      this.#object = new PresenceObject({ state, nowEpochMs: Date.now });
    });
  }

  async recordActivity(activity: PresenceActivity): Promise<PresenceActivityResult> {
    return await this.#object.recordActivity(activity);
  }

  async listActiveMembers(): Promise<PresenceMember[]> {
    return await this.#object.listActiveMembers();
  }
}
