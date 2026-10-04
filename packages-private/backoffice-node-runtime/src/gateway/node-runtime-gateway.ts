import type { GraftNodeLease } from "../graft/graft-control-store";
import { nodeRuntimeReadinessPath } from "../runtime/node-runtime-readiness";

/** Read-only discovery fails closed on stale snapshots; the gateway takes ownership of cleanup. */
export type NodeRuntimeGatewayDirectory = {
  readLiveWorkers(): GraftNodeLease[];
  close(): Promise<void>;
};

/** Forwards once to application-only origins; internal ingress must be isolated at the host. */
export function createNodeRuntimeGateway(options: { directory: NodeRuntimeGatewayDirectory }) {
  let nextWorker = 0;
  const cancellation = new AbortController();
  let closeOperation: Promise<void> | null = null;
  return {
    async fetch(request: Request): Promise<Response> {
      if (cancellation.signal.aborted) {
        return Response.json({ error: "NODE_RUNTIME_GATEWAY_CLOSED" }, { status: 503 });
      }
      const url = new URL(request.url);
      const readiness = url.pathname === nodeRuntimeReadinessPath && request.method === "GET";
      if (
        request.headers.has("upgrade") ||
        (!readiness && (url.pathname === "/_runtime" || url.pathname.startsWith("/_runtime/")))
      ) {
        return Response.json({ error: "NODE_RUNTIME_GATEWAY_ROUTE_NOT_FOUND" }, { status: 404 });
      }
      const signal = AbortSignal.any([request.signal, cancellation.signal]);
      try {
        const workers = options.directory.readLiveWorkers();
        const now = Date.now();
        const candidates = workers.flatMap((worker) =>
          worker.expiresAtMs > now + 1_000
            ? [{ worker, origin: new URL(worker.applicationOrigin) }]
            : [],
        );
        const start = nextWorker++ % Math.max(1, candidates.length);
        let selected: { worker: GraftNodeLease; origin: URL } | null = null;
        // Bound discovery work per request; only probes may fail over, never an application request.
        for (let offset = 0; offset < Math.min(8, candidates.length); offset++) {
          const candidate = candidates[(start + offset) % candidates.length];
          signal.throwIfAborted();
          if (await isGatewayWorkerReady(candidate.worker, candidate.origin, signal)) {
            selected = candidate;
            break;
          }
        }
        if (selected === null) {
          return Response.json(
            { error: "NODE_RUNTIME_GATEWAY_NO_READY_WORKER" },
            {
              status: 503,
              headers: { "cache-control": "no-store" },
            },
          );
        }
        if (readiness) {
          return Response.json({ status: "ready" }, { headers: { "cache-control": "no-store" } });
        }
        signal.throwIfAborted();
        const target = new URL(selected.origin);
        target.pathname = url.pathname;
        target.search = url.search;
        const headers = stripGatewayHopHeaders(request.headers);
        headers.delete("host");
        const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body,
          ...(body === null ? {} : { duplex: "half" }),
          redirect: "manual",
          signal,
        } as RequestInit);
        const responseHeaders = stripGatewayHopHeaders(upstream.headers);
        // Fetch transparently decodes compressed bodies; forwarding these headers corrupts framing.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        responseHeaders.set("x-node-runtime-ingress-node-id", selected.worker.nodeId);
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        console.error("NODE_RUNTIME_GATEWAY_REQUEST_FAILED", error);
        return Response.json({ error: "NODE_RUNTIME_GATEWAY_DELIVERY_UNCERTAIN" }, { status: 503 });
      }
    },
    /** Stop admission and cancel in-flight probes and streams; drain the HTTP listener first if needed. */
    close(): Promise<void> {
      cancellation.abort();
      closeOperation ??= options.directory.close();
      return closeOperation;
    },
  };
}

async function isGatewayWorkerReady(
  worker: GraftNodeLease,
  origin: URL,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
    const ready = await fetch(new URL(nodeRuntimeReadinessPath, origin), {
      signal: probeSignal,
      redirect: "error",
    });
    if (!ready.ok) {
      await ready.body?.cancel();
      return false;
    }
    // An address can be reused by a different incarnation while a stale lease still exists.
    const value: unknown = await ready.json();
    return (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "ready" &&
      "nodeId" in value &&
      value.nodeId === worker.nodeId &&
      "processGeneration" in value &&
      value.processGeneration === worker.processGeneration &&
      worker.expiresAtMs > Date.now() + 1_000
    );
  } catch {
    return false;
  }
}

function stripGatewayHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connection = headers.get("connection");
  for (const name of connection?.split(",") ?? []) {
    headers.delete(name.trim());
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  return headers;
}
