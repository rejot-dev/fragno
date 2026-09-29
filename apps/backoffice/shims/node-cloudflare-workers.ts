import { runNodeOpenTelemetrySpan } from "../app/backoffice-runtime/node/node-opentelemetry-span";

// Node-only build boundary. Worker APIs that require a Cloudflare isolate must not be used here.
export class DurableObject {
  constructor(_state: unknown, _env: unknown) {
    throw new Error("Cloudflare Durable Objects are unavailable in the Node Backoffice runtime.");
  }
}

export class RpcTarget {}
export class WorkerEntrypoint {}

type NodeCloudflareTracingSpan = {
  readonly isTraced: boolean;
  setAttribute(key: string, value: boolean | number | string): void;
};

export const tracing = {
  enterSpan<T>(name: string, callback: (span: NodeCloudflareTracingSpan) => T): T {
    return runNodeOpenTelemetrySpan(name, (span) =>
      callback({
        get isTraced() {
          return span.isRecording();
        },
        setAttribute(key, value) {
          span.setAttribute(key, value);
        },
      }),
    );
  },
};
