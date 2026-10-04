import type { Server } from "node:http";

import { startGraftGatewayDirectory } from "@fragno-private/backoffice-node-runtime/graft-gateway-directory";
import { createNodeRuntimeGateway } from "@fragno-private/backoffice-node-runtime/node-runtime-gateway";

import { createAdaptorServer } from "@hono/node-server";

import { readServingGraftStorage } from "./storage/configured-graft-storage";

const storage = await readServingGraftStorage(process.env);
const gateway = createNodeRuntimeGateway({
  directory: startGraftGatewayDirectory(storage),
});
const host = process.env["HOST"] ?? "0.0.0.0";
const port = Number(process.env["PORT"] ?? 8080);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || host.length === 0) {
  await gateway.close();
  throw new Error("DEMO_GATEWAY_LISTEN_CONFIGURATION_INVALID");
}
let draining = false;
const cancellation = new AbortController();
const server = createAdaptorServer({
  fetch(request) {
    if (draining) {
      return Response.json({ error: "DEMO_GATEWAY_DRAINING" }, { status: 503 });
    }
    return gateway.fetch(
      new Request(request, {
        signal: AbortSignal.any([request.signal, cancellation.signal]),
      }),
    );
  },
}) as Server;
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
console.log(
  `DEMO_GATEWAY_LISTENING:${JSON.stringify({ host, port, controlRemoteLogId: storage.controlRemoteLogId })}`,
);
let shutdown: Promise<void> | null = null;
process.once("SIGINT", stopGateway);
process.once("SIGTERM", stopGateway);

function stopGateway(): void {
  shutdown ??= (async () => {
    draining = true;
    const deadline = setTimeout(() => {
      cancellation.abort();
      server.closeAllConnections();
    }, 8_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections();
      });
    } finally {
      clearTimeout(deadline);
      cancellation.abort();
      await gateway.close();
    }
  })();
  void shutdown.catch((error: unknown) => {
    console.error("DEMO_GATEWAY_SHUTDOWN_FAILED", error);
    process.exitCode = 1;
  });
}
