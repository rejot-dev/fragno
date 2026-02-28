import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import { createAuthServer, type AuthFragment } from "@/fragno/auth";

export class Auth extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: AuthFragment | null = null;
  #fragmentBaseUrl: string | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;

    const fragment = createAuthServer({ type: "live", env, state });
    this.#fragment = fragment;

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(fragment);
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  #getFragment(request: Request) {
    const baseUrl = new URL(request.url).origin;

    if (!this.#fragment || this.#fragmentBaseUrl !== baseUrl) {
      this.#fragment = createAuthServer(
        { type: "live", env: this.#env, state: this.#state },
        { baseUrl },
      );
      this.#fragmentBaseUrl = baseUrl;
    }

    return this.#fragment;
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = this.#getFragment(request);
    return fragment.handler(request);
  }
}
