/**
 * Stands in for the `cloudflare:workers` module outside workerd. Durable Objects keep `ctx` and
 * `env` as Cloudflare's base class does, and `env` holds the running scenario's bindings.
 */
export class DurableObject<TEnv = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export class WorkerEntrypoint {}

export const env: Record<string, unknown> = {};
