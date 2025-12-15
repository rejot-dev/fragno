import { DurableObject } from "cloudflare:workers";
import type { FormsFragment } from "@/fragno/forms";
import { createFormsServer } from "@/fragno/forms";
import { migrate } from "@fragno-dev/db";

export class Forms extends DurableObject<CloudflareEnv> {
  #fragment: FormsFragment;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);

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
    return this.#fragment.handler(request);
  }
}
