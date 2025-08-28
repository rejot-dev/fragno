import express, { type Application } from "express";
import { test, expect, describe, beforeAll, afterAll, assert } from "vitest";
import { z } from "zod";
import {
  createLibrary,
  type FragnoInstantiatedLibrary,
  type FragnoPublicClientConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { toNodeHandler } from "./fragno-node";

describe("Node.js Streaming", () => {
  const testLibraryConfig = {
    name: "test-library",
    routes: [
      addRoute({
        method: "GET",
        path: "/stream",
        outputSchema: z.object({ message: z.string() }),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            await stream.write({ message: "Hello, " });
            await stream.sleep(1);
            await stream.write({ message: "World!" });
          });
        },
      }),
    ],
  } as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost",
  };
  let testLibrary: FragnoInstantiatedLibrary<typeof testLibraryConfig.routes>;
  let app: Application;
  let server: ReturnType<typeof app.listen>;
  let port: number;

  function createExpressServerForTest() {
    testLibrary = createLibrary(clientConfig, testLibraryConfig, {});
    app = express();

    app.all("/api/test-library/{*any}", toNodeHandler(testLibrary.handler));

    // Add JSON body parsing middleware
    app.use(express.json());
    app.get("/some-other-route", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Hello world" }));
    });

    server = app.listen(0);

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Address invalid");
    }

    port = address.port;
    clientConfig.baseUrl = `http://localhost:${port}`;
  }

  beforeAll(() => {
    createExpressServerForTest();
  });

  afterAll(() => {
    server.close();
  });

  test("should fetch data from the GET /stream route", async () => {
    const response = await fetch(`${clientConfig.baseUrl}${testLibrary.mountRoute}/stream`);

    assert(response.body, "Response body is missing");

    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("transfer-encoding")).toBe("chunked");

    const decoder = new TextDecoder();
    let result = "";
    for await (const chunk of response.body) {
      const string = decoder.decode(chunk, { stream: true });
      const lines = string.split("\n");
      for (const line of lines) {
        if (!line) {
          continue;
        }

        const jsonObject = JSON.parse(line);
        result += jsonObject.message;
      }
    }
    expect(result).toBe("Hello, World!");
  });
});
