import express, { type Application } from "express";
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import {
  createLibrary,
  type FragnoInstantiatedLibrary,
  type FragnoPublicClientConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { toNodeHandler } from "./fragno-node";

describe("Fragno Express integration", () => {
  const testLibraryConfig = {
    name: "test-library",
    routes: [
      addRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
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

  test("should fetch data from the GET /users route", async () => {
    const response = await fetch(`${clientConfig.baseUrl}${testLibrary.mountRoute}/users`);

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toEqual([{ id: 1, name: "John" }]);
  });

  test("should fall back to normal express routes for non-lib routes", async () => {
    const response = await fetch(`${clientConfig.baseUrl}/some-other-route`);
    const data = await response.json();
    expect(data).toEqual({ message: "Hello world" });
  });
});
