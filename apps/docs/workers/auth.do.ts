import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { createAuthServer, type AuthFragment } from "@/fragno/auth";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

const resolveAuthBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (forwardedProto === "http" || forwardedProto === "https") {
    requestUrl.protocol = `${forwardedProto}:`;
  }

  return requestUrl.origin;
};

export class Auth extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: AuthFragment | null = null;
  #fragmentBaseUrl: string | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;

    const fragment = createAuthServer({ type: "live", env, state });
    this.#fragment = fragment;

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(fragment);
        this.#ensureDispatcher();
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  #ensureDispatcher() {
    if (!this.#fragment || this.#dispatcher) {
      return;
    }

    try {
      const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
        onProcessError: (error) => {
          console.error("Auth hook processor error", error);
        },
      });
      this.#dispatcher = dispatcherFactory(this.#state, this.#env);
    } catch (error) {
      console.warn("Auth hook processor disabled", error);
      this.#dispatcher = null;
    }
  }

  #ensureFragment() {
    if (!this.#fragment) {
      this.#fragment = createAuthServer({ type: "live", env: this.#env, state: this.#state });
      this.#fragmentBaseUrl = null;
      this.#dispatcher = null;
    }

    this.#ensureDispatcher();

    return this.#fragment;
  }

  #getFragment(request: Request) {
    const baseUrl = resolveAuthBaseUrl(request);

    if (!this.#fragment || this.#fragmentBaseUrl !== baseUrl) {
      this.#fragment = createAuthServer(
        { type: "live", env: this.#env, state: this.#state },
        { baseUrl },
      );
      this.#fragmentBaseUrl = baseUrl;
      this.#dispatcher = null;
    }

    return this.#ensureFragment();
  }

  async alarm() {
    if (this.#dispatcher?.alarm) {
      await this.#dispatcher.alarm();
    }
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const fragment = this.#ensureFragment();
    return await loadDurableHookQueue(fragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = this.#getFragment(request);
    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
