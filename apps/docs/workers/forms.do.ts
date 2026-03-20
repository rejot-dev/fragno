import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";

import type { FormsFragment } from "@/fragno/forms/forms";
import { createFormsServer } from "@/fragno/forms/forms";

export class Forms extends DurableObject<CloudflareEnv> {
  #state: DurableObjectState;
  #fragment: FormsFragment;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;

    this.#fragment = createFormsServer({
      env,
      state: state,
      type: "live",
    });

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#fragment);
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.#fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
