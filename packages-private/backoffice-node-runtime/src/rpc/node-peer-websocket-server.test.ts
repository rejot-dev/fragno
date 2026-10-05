import { test, assert } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket } from "ws";

import { attachNodePeerWebSocketServer } from "./node-peer-websocket-server";

test("the peer WebSocket server accepts only the configured runtime path", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const accepted = Promise.withResolvers<void>();
  const peerServer = attachNodePeerWebSocketServer({
    server,
    path: "/node-object-peer",
    maximumPayloadBytes: 1_024,
    acceptWebSocket() {
      accepted.resolve();
    },
  });
  const port = await listenTestHttpServer(server);
  const acceptedClient = new WebSocket(`ws://127.0.0.1:${port}/node-object-peer`);
  const rejectedClient = new WebSocket(`ws://127.0.0.1:${port}/another-path`);

  try {
    await Promise.all([
      accepted.promise,
      new Promise<void>((resolve, reject) => {
        acceptedClient.once("open", resolve);
        acceptedClient.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        rejectedClient.once("unexpected-response", (_request, response) => {
          try {
            assert(response.statusCode === 404);
            resolve();
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("NODE_PEER_WEBSOCKET_TEST_ASSERTION_FAILED", { cause: error }),
            );
          }
        });
        rejectedClient.once("error", reject);
      }),
    ]);
  } finally {
    acceptedClient.terminate();
    rejectedClient.terminate();
    await peerServer.close();
    await closeTestHttpServer(server);
  }
});

async function listenTestHttpServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

function closeTestHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
