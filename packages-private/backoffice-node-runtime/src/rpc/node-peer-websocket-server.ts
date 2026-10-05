import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

/** Attaches the runtime's peer WebSocket ingress to one runtime-owned Node HTTP server. */
export type NodePeerWebSocketServer = {
  /** Stops accepting upgrades and terminates every remaining peer transport socket. */
  close(): Promise<void>;
};

/** Owns the Node HTTP upgrade boundary for authenticated runtime peer RPC. */
export function attachNodePeerWebSocketServer(options: {
  server: HttpServer;
  path: string;
  maximumPayloadBytes: number;
  acceptWebSocket(webSocket: WebSocket): void;
}): NodePeerWebSocketServer {
  validateNodePeerWebSocketServerOptions(options);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maximumPayloadBytes,
  });
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function handleNodePeerWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = new URL(request.url ?? "/", "http://node-object-runtime.invalid").pathname;
    if (closed || pathname !== options.path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      try {
        options.acceptWebSocket(webSocket as unknown as WebSocket);
      } catch {
        webSocket.terminate();
      }
    });
  }

  options.server.on("upgrade", handleNodePeerWebSocketUpgrade);

  return {
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        closed = true;
        options.server.off("upgrade", handleNodePeerWebSocketUpgrade);
        for (const webSocket of webSocketServer.clients) {
          webSocket.terminate();
        }
        webSocketServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      return closePromise;
    },
  };
}

function validateNodePeerWebSocketServerOptions(options: {
  path: string;
  maximumPayloadBytes: number;
}): void {
  if (!options.path.startsWith("/") || options.path.includes("?") || options.path.includes("#")) {
    throw new Error("NODE_PEER_WEBSOCKET_SERVER_PATH_INVALID");
  }
  if (!Number.isSafeInteger(options.maximumPayloadBytes) || options.maximumPayloadBytes <= 0) {
    throw new Error("NODE_PEER_WEBSOCKET_SERVER_MAXIMUM_PAYLOAD_INVALID");
  }
}
