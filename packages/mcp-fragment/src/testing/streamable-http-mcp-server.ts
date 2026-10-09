/// <reference types="node" />

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { createTestMcpServer, type TestMcpServerOptions } from "./mcp-test-server";

export interface TestMcpServerHandle {
  endpointUrl: string;
  getMcpRequestCount: () => number;
  getTokenRequestCount: () => number;
  close: () => Promise<void>;
}

async function toRequest(request: IncomingMessage, origin: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, item);
    }
  }
  return new Request(new URL(request.url ?? "/", origin), {
    method: request.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

async function writeResponse(response: Response, target: ServerResponse) {
  target.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    target.end();
    return;
  }
  // SSE responses stay open, so stream rather than buffer.
  Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(target);
}

/** Serves the in-process test server over loopback HTTP for clients that need a real socket. */
export async function startStreamableHttpTestMcpServer(
  options: TestMcpServerOptions = {},
): Promise<TestMcpServerHandle> {
  const mcpServer = createTestMcpServer(options);
  const httpServer: Server = createServer((request, response) => {
    void (async () => {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      await writeResponse(await mcpServer.fetch(await toRequest(request, origin)), response);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500).end(error instanceof Error ? error.message : "MCP transport error");
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test MCP server did not bind to a TCP port");
  }

  return {
    endpointUrl: `http://127.0.0.1:${address.port}/mcp`,
    getMcpRequestCount: mcpServer.getMcpRequestCount,
    getTokenRequestCount: mcpServer.getTokenRequestCount,
    close: async () => {
      await mcpServer.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
