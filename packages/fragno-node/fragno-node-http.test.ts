import { createServer, type RequestListener, type Server } from "node:http";
import { test, expect, describe } from "vitest";
import { z } from "zod";
import {
  defineFragment,
  defineRoute,
  createFragment,
  type FragnoInstantiatedFragment,
  type FragnoPublicClientConfig,
} from "@fragno-dev/core";
import { toNodeHandler } from "./fragno-node";

describe("Fragno Node.js integration", () => {
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
  let testFragment: FragnoInstantiatedFragment<[typeof usersRoute]>;
  let server: Server;
  let port: number;

  function createServerForTest(
    listenerFactory: (fragment: FragnoInstantiatedFragment<[typeof usersRoute]>) => RequestListener,
  ) {
    testFragment = createFragment(testFragmentDefinition, {}, [usersRoute], clientConfig);
    server = createServer(listenerFactory(testFragment));
    server.listen(0);

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Address invalid");
    }

    port = address.port;
    clientConfig.baseUrl = `http://localhost:${port}`;

    return {
      close: () => server.close(),
    };
  }

  test("should fetch data from the GET /users route", async () => {
    const { close } = createServerForTest((fragment) => toNodeHandler(fragment.handler));

    const response = await fetch(`${clientConfig.baseUrl}${testFragment.mountRoute}/users`);

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toEqual([{ id: 1, name: "John" }]);

    close();
  });

  test("should fall back to normal server for non-lib routes", async () => {
    const { close } = createServerForTest((fragment) => (req, res) => {
      if (req.url?.startsWith(fragment.mountRoute)) {
        const handler = toNodeHandler(fragment.handler);
        return handler(req, res);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "It's working." }));
      }
    });

    const response = await fetch(`${clientConfig.baseUrl}/`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toEqual({ message: "It's working." });

    close();
  });
});
