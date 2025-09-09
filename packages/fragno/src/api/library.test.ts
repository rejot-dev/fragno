import { test, expect, describe } from "vitest";
import { createLibrary } from "./library";
import { addRoute } from "./api";

describe("createLibrary - handler", () => {
  test("Simple path param", async () => {
    // Create a simple route configuration
    const routes = [
      addRoute({
        method: "GET",
        path: "/thing/:id",
        handler: async (_inputCtx, outputCtx) => {
          return outputCtx.json({ message: "Hello, World!" });
        },
      }),
    ] as const;

    // Create the library
    const library = createLibrary({ mountRoute: "/api" }, { name: "test-library", routes }, {});

    // Create a test request
    const request = new Request("http://localhost:3000/api/thing/123", {
      method: "GET",
    });

    // Call the handler
    const response = await library.handler(request);

    // Verify the response
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: "Hello, World!" });
  });

  test("Wildcard path", async () => {
    // Create a simple route configuration
    const routes = [
      addRoute({
        method: "GET",
        path: "/thing/:id/**:path",
        handler: async (_inputCtx, outputCtx) => {
          return outputCtx.json({ message: "Hello, World!" });
        },
      }),
    ] as const;

    // Create the library
    const library = createLibrary({ mountRoute: "/api" }, { name: "test-library", routes }, {});

    // Create a test request
    const request = new Request("http://localhost:3000/api/thing/123/foo/bar", {
      method: "GET",
    });

    // Call the handler
    const response = await library.handler(request);

    // Verify the response
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: "Hello, World!" });
  });
});
