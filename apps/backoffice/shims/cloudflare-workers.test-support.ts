// Node tests load Cloudflare-target code, such as the Durable Object classes in `workers/`, which
// the Node runtime never does. Unlike `node-cloudflare-workers.ts`, these classes construct.
export class DurableObject {
  constructor(_state: unknown, _env: unknown) {}
}

export class RpcTarget {}
export class WorkerEntrypoint {}
