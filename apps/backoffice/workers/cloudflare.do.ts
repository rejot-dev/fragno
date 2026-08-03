import { DurableObject } from "cloudflare:workers";

import type { CloudflareObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { createCloudflareServer, type CloudflareFragment } from "@/fragno/cloudflare";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

type CloudflareObjectEnv = Partial<
  Pick<CloudflareEnv, "CLOUDFLARE_WORKERS_ACCOUNT_ID" | "CLOUDFLARE_WORKERS_API_TOKEN">
>;

export class InMemoryCloudflareObject implements CloudflareObject {
  readonly #fragment: CloudflareFragment | null;

  constructor({
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: CloudflareObjectEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    const accountId = env?.CLOUDFLARE_WORKERS_ACCOUNT_ID?.trim();
    const apiToken = env?.CLOUDFLARE_WORKERS_API_TOKEN?.trim();

    this.#fragment =
      accountId && apiToken ? createCloudflareServer({ accountId, apiToken }, runtime) : null;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#fragment) {
      return Response.json(
        {
          code: "NOT_CONFIGURED",
          message:
            "Cloudflare is not configured. Set CLOUDFLARE_WORKERS_ACCOUNT_ID and CLOUDFLARE_WORKERS_API_TOKEN.",
        },
        { status: 400 },
      );
    }

    return await this.#fragment.handler(request);
  }
}

export class Cloudflare extends DurableObject<CloudflareEnv> implements CloudflareObject {
  readonly #object: InMemoryCloudflareObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryCloudflareObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
