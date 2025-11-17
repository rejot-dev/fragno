import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-definition-builder";
import { instantiate, NewFragnoInstantiatedFragment } from "./fragment-instantiator";
import { defineRoute, defineRoutesNew, type AnyNewFragmentDefinition } from "./route";
import type { FragnoPublicConfig } from "./shared-types";
import type { RequestThisContext } from "./api";
import { z } from "zod";

describe("fragment-instantiator", () => {
  describe("basic instantiation", () => {
    it("should instantiate a fragment with config and routes", () => {
      interface Config {
        apiKey: string;
      }

      const definition = defineFragment<Config>("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "hello" });
        },
      });

      const fragment = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      expect(fragment).toBeInstanceOf(NewFragnoInstantiatedFragment);
      expect(fragment.name).toBe("test-fragment");
      expect(fragment.routes).toHaveLength(1);
      expect(fragment.mountRoute).toBe("/api");
    });

    it("should instantiate without config or routes", () => {
      const definition = defineFragment("minimal-fragment").build();

      const fragment = instantiate(definition).build();

      expect(fragment).toBeInstanceOf(NewFragnoInstantiatedFragment);
      expect(fragment.name).toBe("minimal-fragment");
      expect(fragment.routes).toHaveLength(0);
    });
  });

  describe("dependencies", () => {
    it("should call dependencies callback and expose deps", () => {
      interface Config {
        apiKey: string;
      }

      interface Deps {
        client: { apiKey: string };
      }

      const definition = defineFragment<Config, FragnoPublicConfig>(" test-fragment")
        .withDependencies(
          ({ config }): Deps => ({
            client: { apiKey: config.apiKey },
          }),
        )
        .build();

      const fragment = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withOptions({})
        .build();

      expect(fragment.$internal.deps).toEqual({
        client: { apiKey: "test-key" },
      });
    });

    it("should provide options to dependencies callback", () => {
      interface Config {
        value: string;
      }

      interface Options extends FragnoPublicConfig {
        customOption: string;
      }

      const definition = defineFragment<Config, Options>("test-fragment")
        .withDependencies(({ config, options }) => ({
          combined: `${config.value}-${options.customOption}`,
        }))
        .build();

      const fragment = instantiate(definition)
        .withConfig({ value: "config" })
        .withOptions({ customOption: "option" })
        .build();

      expect(fragment.$internal.deps).toEqual({
        combined: "config-option",
      });
    });
  });

  describe("base services", () => {
    it("should call baseServices callback and expose services", () => {
      interface Config {
        prefix: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => ({
          prefix: config.prefix,
        }))
        .providesBaseService(({ deps }) => ({
          greet: (name: string) => `${deps.prefix} ${name}`,
        }))
        .build();

      const fragment = instantiate(definition)
        .withConfig({ prefix: "Hello" })
        .withOptions({})
        .build();

      expect(fragment.services.greet("World")).toBe("Hello World");
    });

    it("should provide config, options, deps to baseServices", () => {
      interface Config {
        value: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => ({
          dep: config.value,
        }))
        .providesBaseService(({ config, deps }) => ({
          getValue: () => `${config.value}-${deps.dep}`,
        }))
        .build();

      const fragment = instantiate(definition)
        .withConfig({ value: "test" })
        .withOptions({})
        .build();

      expect(fragment.services.getValue()).toBe("test-test");
    });
  });

  describe("named services", () => {
    it("should call namedServices factories and expose services", () => {
      const definition = defineFragment("test-fragment")
        .providesService("mathService", () => ({
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        }))
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(fragment.services.mathService.add(2, 3)).toBe(5);
      expect(fragment.services.mathService.multiply(4, 5)).toBe(20);
    });

    it("should provide context to named service factories", () => {
      interface Config {
        multiplier: number;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => ({
          multiplier: config.multiplier,
        }))
        .providesService("mathService", ({ deps }) => ({
          scale: (value: number) => value * deps.multiplier,
        }))
        .build();

      const fragment = instantiate(definition)
        .withConfig({ multiplier: 10 })
        .withOptions({})
        .build();

      expect(fragment.services.mathService.scale(5)).toBe(50);
    });

    it("should merge base services and named services", () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          baseMethod: () => "base",
        }))
        .providesService("namedService", () => ({
          namedMethod: () => "named",
        }))
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(fragment.services.baseMethod()).toBe("base");
      expect(fragment.services.namedService.namedMethod()).toBe("named");
    });
  });

  describe("service dependencies", () => {
    it("should validate required service dependencies", () => {
      interface EmailService {
        send: (to: string) => Promise<void>;
      }

      const definition = defineFragment("test-fragment")
        .usesService<"emailService", EmailService>("emailService")
        .build();

      expect(() => {
        instantiate(definition).withOptions({}).build();
      }).toThrow("Fragment 'test-fragment' requires service 'emailService'");
    });

    it("should accept provided service dependencies", () => {
      interface EmailService {
        send: (to: string) => Promise<void>;
      }

      const emailService: EmailService = {
        send: async (to: string) => {
          console.log(`Sending email to ${to}`);
        },
      };

      const definition = defineFragment("test-fragment")
        .usesService<"emailService", EmailService>("emailService")
        .providesBaseService(({ serviceDeps }) => ({
          sendWelcomeEmail: async (to: string) => {
            await serviceDeps.emailService.send(to);
          },
        }))
        .build();

      const fragment = instantiate(definition)
        .withOptions({})
        .withServices({ emailService })
        .build();

      expect(fragment.services.sendWelcomeEmail).toBeDefined();
    });

    it("should provide serviceDeps to base services", () => {
      interface AuthService {
        getCurrentUser: () => { id: string; name: string };
      }

      const authService: AuthService = {
        getCurrentUser: () => ({ id: "123", name: "John" }),
      };

      const definition = defineFragment("test-fragment")
        .usesService<"authService", AuthService>("authService")
        .providesBaseService(({ serviceDeps }) => ({
          getUserName: () => serviceDeps.authService.getCurrentUser().name,
        }))
        .build();

      const fragment = instantiate(definition)
        .withOptions({})
        .withServices({ authService })
        .build();

      expect(fragment.services.getUserName()).toBe("John");
    });

    it("should provide serviceDeps to named services", () => {
      interface AuthService {
        getCurrentUser: () => { id: string };
      }

      const authService: AuthService = {
        getCurrentUser: () => ({ id: "123" }),
      };

      const definition = defineFragment("test-fragment")
        .usesService<"authService", AuthService>("authService")
        .providesService("userService", ({ serviceDeps }) => ({
          getUserId: () => serviceDeps.authService.getCurrentUser().id,
        }))
        .build();

      const fragment = instantiate(definition)
        .withOptions({})
        .withServices({ authService })
        .build();

      expect(fragment.services.userService.getUserId()).toBe("123");
    });

    it("should combine uses, provides, and base services", () => {
      interface AuthService {
        getCurrentUser: () => { id: string };
      }

      const authService: AuthService = {
        getCurrentUser: () => ({ id: "123" }),
      };

      const definition = defineFragment("test-fragment")
        .usesService<"authService", AuthService>("authService")
        .providesService("userService", ({ serviceDeps }) => ({
          getUserId: () => serviceDeps.authService.getCurrentUser().id,
        }))
        .providesBaseService(({ serviceDeps }) => ({
          getNextUserId: () => serviceDeps.authService.getCurrentUser().id + 1,
        }))
        .build();

      const fragment = instantiate(definition)
        .withOptions({})
        .withServices({ authService })
        .build();

      const services = fragment.services;
      expectTypeOf(services).toMatchObjectType<{
        getNextUserId: () => string;
        userService: { getUserId: () => string };
      }>();
    });
  });

  describe("handler execution", () => {
    it("should execute route handlers via handler method", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "Hello World" });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/hello");
      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ message: "Hello World" });
    });

    it("should return 404 for unknown routes", async () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition)
        .withRoutes([])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/unknown");
      const response = await fragment.handler(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.code).toBe("ROUTE_NOT_FOUND");
    });

    it("should return 404 for wrong mount route", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "Hello" });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/wrong/hello");
      const response = await fragment.handler(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.code).toBe("ROUTE_NOT_FOUND");
    });

    it("should handle route with path params", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/users/:id",
        handler: async (input, { json }) => {
          return json({ userId: input.pathParams.id });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/users/123");
      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ userId: "123" });
    });

    it("should handle POST requests with body", async () => {
      const definition = defineFragment("test-fragment").build();

      const inputSchema = z.object({
        test: z.string(),
      });

      const route = defineRoute({
        method: "POST",
        path: "/data",
        inputSchema,
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({ received: body });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "data" }),
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ received: { test: "data" } });
    });
  });

  describe("callRoute", () => {
    it("should call route directly with callRoute", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "Hello from callRoute" });
        },
      });

      const fragment = instantiate(definition).withRoutes([route]).withOptions({}).build();

      const response = await fragment.callRoute("GET", "/hello");

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ message: "Hello from callRoute" });
      }
    });

    it("should pass path params to callRoute", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/users/:id",
        handler: async (input, { json }) => {
          return json({ userId: input.pathParams.id });
        },
      });

      const fragment = instantiate(definition).withRoutes([route]).withOptions({}).build();

      const response = await fragment.callRoute("GET", "/users/:id", {
        pathParams: { id: "456" },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ userId: "456" });
      }
    });

    it("should pass body to callRoute", async () => {
      const definition = defineFragment("test-fragment").build();

      const inputSchema = z.object({
        test: z.string(),
      });

      const route = defineRoute({
        method: "POST",
        path: "/data",
        inputSchema,
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({ received: body });
        },
      });

      const fragment = instantiate(definition).withRoutes([route]).withOptions({}).build();

      const response = await fragment.callRoute("POST", "/data", {
        body: { test: "data" },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ received: { test: "data" } });
      }
    });

    it("should return error for unknown route in callRoute", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/exists",
        handler: async (_input, { json }) => {
          return json({ message: "exists" });
        },
      });

      const fragment = instantiate(definition).withRoutes([route]).withOptions({}).build();

      // @ts-expect-error - /unknown is not a valid route
      const response = await fragment.callRouteRaw("GET", "/unknown");

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.code).toBe("ROUTE_NOT_FOUND");
    });
  });

  describe("callRouteRaw", () => {
    it("should call route and return raw Response", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "Raw response" });
        },
      });

      const fragment = instantiate(definition).withRoutes([route]).withOptions({}).build();

      const response = await fragment.callRouteRaw("GET", "/hello");

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ message: "Raw response" });
    });
  });

  describe("middleware", () => {
    it("should execute middleware before handler", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "Hello" });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const middlewareSpy = vi.fn();

      fragment.withMiddleware(async (input, _output) => {
        middlewareSpy(input.path);
        // Don't return anything to allow request to continue
        return undefined;
      });

      const request = new Request("http://localhost/api/hello");
      await fragment.handler(request);

      expect(middlewareSpy).toHaveBeenCalledWith("/hello");
    });

    it("should short-circuit with middleware response", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        handler: async (_input, { json }) => {
          return json({ message: "From handler" });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      fragment.withMiddleware(async () => {
        return Response.json({ message: "From middleware" });
      });

      const request = new Request("http://localhost/api/hello");
      const response = await fragment.handler(request);

      const data = await response.json();
      expect(data).toEqual({ message: "From middleware" });
    });

    it("should throw error when setting middleware twice", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withOptions({}).build();

      fragment.withMiddleware(async () => {
        return undefined;
      });

      expect(() => {
        fragment.withMiddleware(async () => {
          return undefined;
        });
      }).toThrow("Middleware already set");
    });
  });

  describe("handlersFor", () => {
    it("should generate astro handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("astro");

      expect(handlers).toHaveProperty("ALL");
      expect(typeof handlers.ALL).toBe("function");
    });

    it("should generate react-router handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("react-router");

      expect(handlers).toHaveProperty("loader");
      expect(handlers).toHaveProperty("action");
      expect(typeof handlers.loader).toBe("function");
      expect(typeof handlers.action).toBe("function");
    });

    it("should generate next-js handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("next-js");

      expect(handlers).toHaveProperty("GET");
      expect(handlers).toHaveProperty("POST");
      expect(handlers).toHaveProperty("PUT");
      expect(handlers).toHaveProperty("DELETE");
      expect(handlers).toHaveProperty("PATCH");
    });

    it("should generate svelte-kit handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("svelte-kit");

      expect(handlers).toHaveProperty("GET");
      expect(handlers).toHaveProperty("POST");
    });

    it("should generate solid-start handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("solid-start");

      expect(handlers).toHaveProperty("GET");
      expect(handlers).toHaveProperty("POST");
    });

    it("should generate tanstack-start handlers", () => {
      const definition = defineFragment("test-fragment").build();

      const fragment = instantiate(definition).withRoutes([]).withOptions({}).build();

      const handlers = fragment.handlersFor("tanstack-start");

      expect(handlers).toHaveProperty("GET");
      expect(handlers).toHaveProperty("POST");
    });
  });

  describe("request context", () => {
    it("should use custom thisContext from createRequestContext", async () => {
      interface CustomThisContext extends RequestThisContext {
        customMethod: () => string;
      }

      const definition = defineFragment("test-fragment").build();

      // Manually add createRequestContext to definition
      const definitionWithContext = {
        ...definition,
        createRequestContext: () => ({
          customMethod: () => "custom value",
        }),
      } satisfies AnyNewFragmentDefinition;

      const route = defineRoute({
        method: "GET",
        path: "/test",
        handler: async function (this: CustomThisContext, _input, { json }) {
          return json({ value: this.customMethod() });
        },
      });

      const fragment = instantiate(definitionWithContext)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/test");
      const response = await fragment.handler(request);

      const data = await response.json();
      expect(data).toEqual({ value: "custom value" });
    });

    it("should create fresh context per request", async () => {
      const contextCreationSpy = vi.fn();

      const definition = defineFragment("test-fragment")
        .withRequestStorage(() => ({ counter: 0 }))
        .withRequestThisContext(({ storage }) => ({
          get requestId() {
            contextCreationSpy();
            return { text: "default", counter: ++storage.getStore().counter };
          },
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/test",
            handler: async function (_input, { json }) {
              return json({ requestId: this.requestId });
            },
          }),
        ];
      });

      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/test");
      const response = await fragment.handler(request);
      expect(contextCreationSpy).toHaveBeenCalled();
      const data = await response.json();
      expect(data).toEqual({ requestId: { text: "default", counter: 1 } });

      const response2 = await fragment.handler(request);
      const data2 = await response2.json();
      expect(data2).toEqual({ requestId: { text: "default", counter: 1 } });

      expect(contextCreationSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("defineService with custom this context", () => {
    it("withRequestThisContext types", () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key", number: 5 }))
        .withRequestThisContext(() => ({
          x: 3,
          y: "hello",
          get someNumber() {
            return 5;
          },
        }))
        .providesBaseService(({ deps, defineService }) =>
          defineService({
            method1: function () {
              expectTypeOf(this).toMatchObjectType<{
                x: number;
                y: string;
                readonly someNumber: number;
              }>();

              return `${deps.apiKey}-${this.someNumber}`;
            },
          }),
        )
        .build();

      expectTypeOf(definition.$thisContext!).toMatchObjectType<{
        x: number;
        y: string;
        readonly someNumber: number;
      }>();

      expect(definition.createRequestContext).toBeDefined();
    });

    it("withRequestStorage allows mutating stored data", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ startingCounter: 5 }))
        .withRequestStorage(({ deps }) => ({ counter: deps.startingCounter }))
        .withRequestThisContext(({ storage }) => ({
          // Getter to access current counter value from storage
          get counter() {
            return storage.getStore().counter;
          },
          // Method to increment the counter in storage
          incrementCounter() {
            storage.getStore().counter++;
          },
        }))
        .providesBaseService(({ defineService }) =>
          defineService({
            // Service that reads the counter
            getCounter: function () {
              return this.counter;
            },
            // Service that increments the stored counter
            incrementCounter: function () {
              this.incrementCounter();
              return this.counter;
            },
          }),
        )
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test-counter",
          handler: async function (_input, { json }) {
            // Type check: this should have counter property and incrementCounter method
            expectTypeOf(this).toMatchObjectType<{
              readonly counter: number;
              incrementCounter: () => void;
            }>();

            // Read initial counter (starts at 0)
            const initial = services.getCounter();

            // Increment through service - this mutates the storage
            const afterFirst = services.incrementCounter();
            const afterSecond = services.incrementCounter();

            // Direct access via this also shows the mutated value
            const thisCounter = this.counter;

            // Increment via this context directly
            this.incrementCounter();
            const afterDirect = this.counter;

            return json({
              initial,
              afterFirst,
              afterSecond,
              thisCounter,
              afterDirect,
            });
          },
        }),
      ]);

      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api" })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/test-counter"));
      const data = await response.json();

      // The counter increments are persisted in storage throughout the request
      expect(data).toEqual({
        initial: 5,
        afterFirst: 6,
        afterSecond: 7,
        thisCounter: 7,
        afterDirect: 8,
      });

      expect(response.status).toBe(200);
    });

    it("should allow services to use custom this context at runtime", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key", number: 5 }))
        .withRequestThisContext(({ deps }) => ({
          get someNumber() {
            return deps.number;
          },
        }))
        .providesBaseService(({ deps, defineService }) =>
          defineService({
            method1: function () {
              expectTypeOf(this).toMatchObjectType<{
                readonly someNumber: number;
              }>();

              return `${deps.apiKey}-${this.someNumber}`;
            },
          }),
        )
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(fragment.services.method1).toBeDefined();

      // Calling the service method outside of a request context will not work properly
      const result1 = fragment.services.method1();
      expect(result1).toBe("key-5");

      // Now let's use defineRoutesNew to access services properly in routes
      const routesFactory = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/test-service",
            handler: async function (_input, { json }) {
              expectTypeOf(this).toMatchObjectType<{
                readonly someNumber: number;
              }>();

              expect(this).toMatchObject({
                someNumber: 5,
              });

              // Services are available from the route factory context!
              const serviceResult = services.method1();
              return json({ result: serviceResult + "-" + (this.someNumber + 1) });
            },
          }),
        ];
      });

      const fragmentWithRoute = instantiate(definition)
        .withRoutes([routesFactory])
        .withOptions({ mountRoute: "/api" })
        .build();

      const response = await fragmentWithRoute.handler(
        new Request("http://localhost/api/test-service"),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ result: "key-5-6" });
    });

    it("should be able to call services with bound context using inContext", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .withRequestThisContext(() => ({
          myThisNumber: 0,
          myThisString: "hello",
        }))
        .providesBaseService(({ deps, defineService }) =>
          defineService({
            method1: function () {
              expectTypeOf(this).toMatchObjectType<{
                myThisNumber: number;
                myThisString: string;
              }>();

              console.log("this", this);

              this.myThisNumber++;
              return `${deps.apiKey}-${++this.myThisNumber}`;
            },
          }),
        )
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(fragment.services.method1).toBeDefined();
      const result2 = fragment.inContext(() => fragment.services.method1());
      expect(result2).toBe("key-2");
    });
  });

  describe("defineRoutesNew with services", () => {
    it("should provide base services in route factory context", () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          greet: (name: string) => `Hello, ${name}!`,
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        // Verify base service is accessible
        expectTypeOf(services).toMatchObjectType<{
          greet: (name: string) => string;
        }>();

        return [
          defineRoute({
            method: "GET",
            path: "/greet",
            handler: async (_input, { json }) => {
              const message = services.greet("World");
              return json({ message });
            },
          }),
        ];
      });

      expect(routes).toBeDefined();
      expect(typeof routes).toBe("function");
    });

    it("should provide named services in route factory context", () => {
      const definition = defineFragment("test-fragment")
        .providesService("mathService", () => ({
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        // Verify named service is accessible
        expectTypeOf(services).toMatchObjectType<{
          mathService: {
            add: (a: number, b: number) => number;
            multiply: (a: number, b: number) => number;
          };
        }>();

        return [
          defineRoute({
            method: "GET",
            path: "/math",
            handler: async (_input, { json }) => {
              const sum = services.mathService.add(2, 3);
              const product = services.mathService.multiply(4, 5);
              return json({ sum, product });
            },
          }),
        ];
      });

      expect(routes).toBeDefined();
    });

    it("should provide both base and named services in route factory context", () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          baseMethod: () => "base",
        }))
        .providesService("namedService", () => ({
          namedMethod: () => "named",
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        // Verify both base and named services are accessible
        expectTypeOf(services.baseMethod).toBeFunction();
        expectTypeOf(services.namedService).toBeObject();
        expectTypeOf(services.namedService.namedMethod).toBeFunction();

        return [
          defineRoute({
            method: "GET",
            path: "/combined",
            handler: async (_input, { json }) => {
              const base = services.baseMethod();
              const named = services.namedService.namedMethod();
              return json({ base, named });
            },
          }),
        ];
      });

      expect(routes).toBeDefined();
    });

    it("should have services in route context match fragment.services at runtime", async () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          baseMethod: () => "base-value",
        }))
        .providesService("namedService", () => ({
          namedMethod: () => "named-value",
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async (_input, { json }) => {
            return json({
              base: services.baseMethod(),
              named: services.namedService.namedMethod(),
            });
          },
        }),
      ]);

      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api" })
        .build();

      // Verify fragment.services has the same structure
      expect(fragment.services.baseMethod()).toBe("base-value");
      expect(fragment.services.namedService.namedMethod()).toBe("named-value");

      // Verify route can access services with the same structure
      const response = await fragment.handler(new Request("http://localhost/api/test"));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        base: "base-value",
        named: "named-value",
      });
    });

    it("should allow multiple named services in route factory context", () => {
      const definition = defineFragment("test-fragment")
        .providesService("service1", () => ({
          method1: () => "value1",
        }))
        .providesService("service2", () => ({
          method2: () => "value2",
        }))
        .providesService("service3", () => ({
          method3: () => "value3",
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        // Verify all named services are accessible
        expectTypeOf(services.service1).toBeObject();
        expectTypeOf(services.service1.method1).toBeFunction();
        expectTypeOf(services.service2).toBeObject();
        expectTypeOf(services.service2.method2).toBeFunction();
        expectTypeOf(services.service3).toBeObject();
        expectTypeOf(services.service3.method3).toBeFunction();

        return [
          defineRoute({
            method: "GET",
            path: "/multi",
            handler: async (_input, { json }) => {
              return json({
                v1: services.service1.method1(),
                v2: services.service2.method2(),
                v3: services.service3.method3(),
              });
            },
          }),
        ];
      });

      expect(routes).toBeDefined();
    });

    it("should provide services with dependencies in route factory context", () => {
      interface Config {
        prefix: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => ({
          prefix: config.prefix,
        }))
        .providesBaseService(({ deps }) => ({
          greet: (name: string) => `${deps.prefix} ${name}`,
        }))
        .providesService("formatter", ({ deps }) => ({
          format: (text: string) => `[${deps.prefix}] ${text}`,
        }))
        .build();

      const routes = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        // Verify services are accessible
        expectTypeOf(services).toMatchObjectType<{
          greet: (name: string) => string;
          formatter: {
            format: (text: string) => string;
          };
        }>();

        return [
          defineRoute({
            method: "GET",
            path: "/format",
            handler: async (_input, { json }) => {
              return json({
                greeting: services.greet("World"),
                formatted: services.formatter.format("Hello"),
              });
            },
          }),
        ];
      });

      expect(routes).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should handle errors in route handlers", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/error",
        handler: async () => {
          throw new Error("Test error");
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/error");
      const response = await fragment.handler(request);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("should handle errors in middleware", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/test",
        handler: async (_input, { json }) => {
          return json({ message: "test" });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      fragment.withMiddleware(async () => {
        throw new Error("Middleware error");
      });

      const request = new Request("http://localhost/api/test");
      const response = await fragment.handler(request);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });
});
