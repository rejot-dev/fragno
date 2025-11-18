import express, { type Application } from "express";
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { defineFragment, defineRoute, instantiate } from "@fragno-dev/core";
import { type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { toNodeHandler } from "./fragno-node";

describe("Fragno Express integration", () => {
  const testFragmentDefinition = defineFragment("test-fragment");

  const usersRoute = defineRoute({
    method: "GET",
    path: "/users",
    outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
    handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
  });

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost",
  };

  function instantiateTestFragment() {
    return instantiate(testFragmentDefinition)
      .withRoutes([usersRoute])
      .withOptions(clientConfig)
      .build();
  }

  let testFragment: ReturnType<typeof instantiateTestFragment>;
  let app: Application;
  let server: ReturnType<typeof app.listen>;
  let port: number;

  function createExpressServerForTest() {
    testFragment = instantiateTestFragment();
    app = express();

    app.all("/api/test-fragment/{*any}", toNodeHandler(testFragment.handler));

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
    const response = await fetch(`${clientConfig.baseUrl}${testFragment.mountRoute}/users`);

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
