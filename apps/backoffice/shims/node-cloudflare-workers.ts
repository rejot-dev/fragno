// Node-only build boundary. Worker APIs that require a Cloudflare isolate must not be used here.
export class DurableObject {
  constructor(_state: unknown, _env: unknown) {
    throw new Error("Cloudflare Durable Objects are unavailable in the Node Backoffice runtime.");
  }
}

export class RpcTarget {}
export class WorkerEntrypoint {}

export const tracing = {
  enterSpan<T>(_name: string, callback: (span: Span) => T): T {
    return callback({ setAttribute() {} } as unknown as Span);
  },
};
