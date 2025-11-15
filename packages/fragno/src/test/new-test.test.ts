import { describe, it, expect } from "vitest";
import { createFragmentForTest, withTestUtils } from "./new-test";
import { defineFragment } from "../api/fragment-definition-builder";
import { defineRoutesNew } from "../api/route";
import { z } from "zod";

describe("withTestUtils extension", () => {
  it("should expose deps via services.deps", () => {
    const definition = defineFragment<{ apiKey: string }>("test")
      .withDependencies(({ config }) => ({
        client: { apiKey: config.apiKey },
      }))
      .extend(withTestUtils())
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { apiKey: "test-key" },
    });

    expect(fragment.services.deps).toEqual({ client: { apiKey: "test-key" } });
  });

  it("should work with empty deps", () => {
    const definition = defineFragment<{ value: number }>("test").extend(withTestUtils()).build();

    const fragment = createFragmentForTest(definition, [], {
      config: { value: 5 },
    });

    expect(fragment.services.deps).toEqual({});
  });

  it("should preserve existing base services", () => {
    const definition = defineFragment<{ x: number; y: number }>("test")
      .withDependencies(({ config }) => ({
        x: config.x,
        y: config.y,
      }))
      .providesBaseService(({ deps, defineService }) =>
        defineService({
          add: () => deps.x + deps.y,
          multiply: () => deps.x * deps.y,
        }),
      )
      .extend(withTestUtils())
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { x: 3, y: 4 },
    });

    // Both existing services and deps should be available
    expect(fragment.services.add()).toBe(7);
    expect(fragment.services.multiply()).toBe(12);
    expect(fragment.services.deps).toEqual({ x: 3, y: 4 });
  });

  it("should work with named services", () => {
    const definition = defineFragment<{ value: number }>("test")
      .withDependencies(({ config }) => ({
        value: config.value,
      }))
      .providesService("math", ({ deps, defineService }) =>
        defineService({
          double: () => deps.value * 2,
        }),
      )
      .extend(withTestUtils())
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { value: 21 },
    });

    expect(fragment.services.deps).toEqual({ value: 21 });
    expect(fragment.services.math.double()).toBe(42);
  });

  it("should work with service dependencies", () => {
    type Logger = { log: (msg: string) => void };

    const logs: string[] = [];
    const mockLogger: Logger = {
      log: (msg: string) => logs.push(msg),
    };

    const definition = defineFragment<{ name: string }>("test")
      .withDependencies(({ config }) => ({
        name: config.name,
      }))
      .usesService<"logger", Logger>("logger")
      .providesBaseService(({ deps, serviceDeps, defineService }) =>
        defineService({
          greet: () => {
            serviceDeps.logger.log(`Hello, ${deps.name}!`);
          },
        }),
      )
      .extend(withTestUtils())
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { name: "World" },
      serviceImplementations: {
        logger: mockLogger,
      },
    });

    expect(fragment.services.deps).toEqual({ name: "World" });
    fragment.services.greet();
    expect(logs).toEqual(["Hello, World!"]);
  });

  it("should work with request storage and context", () => {
    type RequestStorage = { counter: number };

    const definition = defineFragment<{ initialValue: number }>("test")
      .withDependencies(({ config }) => ({
        initialValue: config.initialValue,
      }))
      .withRequestStorage(
        ({ deps }): RequestStorage => ({
          counter: deps.initialValue,
        }),
      )
      .withRequestThisContext(({ storage }) => ({
        getCounter: () => storage.getStore()?.counter ?? 0,
      }))
      .extend(withTestUtils())
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { initialValue: 10 },
    });

    expect(fragment.services.deps).toEqual({ initialValue: 10 });
  });
});

describe("createFragmentForTest", () => {
  it("should instantiate fragments with routes", async () => {
    type Config = { multiplier: number };

    const definition = defineFragment<Config>("test")
      .withDependencies(({ config }) => ({ multiplier: config.multiplier }))
      .providesService("math", ({ deps, defineService }) =>
        defineService({
          multiply: (x: number) => x * deps.multiplier,
        }),
      )
      .extend(withTestUtils())
      .build();

    const routeFactory = defineRoutesNew(definition).create(({ services, defineRoute }) => [
      defineRoute({
        method: "GET",
        path: "/multiply/:num",
        outputSchema: z.object({ result: z.number(), deps: z.object({ multiplier: z.number() }) }),
        handler: async ({ pathParams }, { json }) => {
          const { num } = pathParams;
          return json({
            result: services.math.multiply(Number(num)),
            deps: services.deps,
          });
        },
      }),
    ]);

    const fragment = createFragmentForTest(definition, [routeFactory], {
      config: { multiplier: 3 },
    });

    const response = await fragment.callRoute("GET", "/multiply/:num", {
      pathParams: { num: "5" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({
        result: 15,
        deps: { multiplier: 3 },
      });
    }
  });

  it("should support request context in routes", async () => {
    type RequestStorage = { counter: number };

    const definition = defineFragment<{ initialValue: number }>("test")
      .withDependencies(({ config }) => ({
        initialValue: config.initialValue,
      }))
      .extend(withTestUtils())
      .withRequestStorage(
        ({ deps }): RequestStorage => ({
          counter: deps.initialValue,
        }),
      )
      .withRequestThisContext(({ storage }) => ({
        getCounter: () => storage.getStore()?.counter ?? 0,
        incrementCounter: () => {
          const store = storage.getStore();
          if (store) {
            store.counter++;
          }
        },
      }))
      .build();

    const routeFactory = defineRoutesNew(definition).create(({ defineRoute }) => [
      defineRoute({
        method: "POST",
        path: "/increment",
        outputSchema: z.object({ count: z.number() }),
        handler: async function (_ctx, { json }) {
          this.incrementCounter();
          return json({ count: this.getCounter() });
        },
      }),
    ]);

    const fragment = createFragmentForTest(definition, [routeFactory], {
      config: { initialValue: 10 },
    });

    // Each request should have its own isolated storage
    const response1 = await fragment.callRoute("POST", "/increment");
    expect(response1.type).toBe("json");
    if (response1.type === "json") {
      expect(response1.data).toEqual({ count: 11 });
    }

    // New request should start fresh
    const response2 = await fragment.callRoute("POST", "/increment");
    expect(response2.type).toBe("json");
    if (response2.type === "json") {
      expect(response2.data).toEqual({ count: 11 }); // Not 12!
    }
  });

  it("should work without withTestUtils (no deps exposed)", () => {
    const definition = defineFragment<{ value: number }>("test")
      .withDependencies(({ config }) => ({
        value: config.value,
      }))
      .providesBaseService(({ deps, defineService }) =>
        defineService({
          getValue: () => deps.value,
        }),
      )
      .build();

    const fragment = createFragmentForTest(definition, [], {
      config: { value: 42 },
    });

    // Services should work
    expect(fragment.services.getValue()).toBe(42);
    // But deps should not be exposed
    expect(fragment.services).not.toHaveProperty("deps");
  });
});
