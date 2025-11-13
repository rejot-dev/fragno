import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-definition-builder";
import { instantiate, NewFragnoInstantiatedFragment } from "./fragment-instantiator";
import { defineRoute, defineRoutesNew } from "./route";
import type { FragnoPublicConfig } from "./fragment-instantiation";
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
      interface CustomThisContext {
        customMethod: () => string;
      }

      const customContext: CustomThisContext = {
        customMethod: () => "custom value",
      };

      const definition = defineFragment("test-fragment").build();

      // Manually add createRequestContext to definition
      const definitionWithContext = {
        ...definition,
        createRequestContext: () => ({
          thisContext: customContext,
          wrapRequest: <T>(cb: () => Promise<T>) => cb(),
        }),
      };

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

    it("should use wrapRequest from createRequestContext", async () => {
      const wrapperSpy = vi.fn();

      const definition = defineFragment("test-fragment").build();

      const definitionWithContext = {
        ...definition,
        createRequestContext: () => ({
          thisContext: {},
          wrapRequest: async <T>(cb: () => Promise<T>) => {
            wrapperSpy();
            return cb();
          },
        }),
      };

      const route = defineRoute({
        method: "GET",
        path: "/test",
        handler: async (_input, { json }) => {
          return json({ message: "test" });
        },
      });

      const fragment = instantiate(definitionWithContext)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/test");
      await fragment.handler(request);

      expect(wrapperSpy).toHaveBeenCalled();
    });
  });

  describe("defineService with custom this context", () => {
    it("should allow services to use custom this context at runtime", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .withRequestContext(() => ({
          thisContext: { myThisNumber: 0, myThisString: "hello" },
          wrapRequest: <T>(cb: () => Promise<T>) => cb(),
        }))
        .providesBaseService(({ deps, defineService }) =>
          defineService({
            method1: function () {
              expectTypeOf(this).toMatchObjectType<{
                myThisNumber: number;
                myThisString: string;
              }>();

              this.myThisNumber++;
              return `${deps.apiKey}-${this.myThisNumber}`;
            },
          }),
        )
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(fragment.services.method1).toBeDefined();

      // Calling the service method outside of a request context will not work properly
      const result1 = fragment.services.method1();
      expect(result1).toBe("key-NaN");

      // Now let's use defineRoutesNew to access services properly in routes
      const routesFactory = defineRoutesNew(definition).create(({ services, defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/test-service",
            handler: async function (_input, { json }) {
              expectTypeOf(this).toMatchObjectType<{
                myThisNumber: number;
                myThisString: string;
              }>();

              expect(this).toMatchObject({
                myThisNumber: 0,
                myThisString: "hello",
              });

              // Services are available from the route factory context!
              const serviceResult = services.method1();
              return json({ result: serviceResult });
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
      // The service is called with the bound context, so it gets NaN again
      // This demonstrates the problem with binding at instantiation time
      expect(data).toEqual({ result: "key-NaN" });
    });

    it("should work with defineRoutesNew using type-only", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "test-key" }))
        .providesBaseService(() => ({
          greet: (name: string) => `Hello, ${name}`,
        }))
        .build();

      // Use defineRoutesNew with type-only (without passing the value)
      const routesFactory = defineRoutesNew<typeof definition>().create(
        ({ services, deps, defineRoute }) => {
          return [
            defineRoute({
              method: "GET",
              path: "/greet/:name",
              handler: async (input, { json }) => {
                // Services and deps are properly typed!
                const greeting = services.greet(input.pathParams.name);
                const key = deps.apiKey;
                return json({ greeting, key });
              },
            }),
          ];
        },
      );

      const fragment = instantiate(definition)
        .withRoutes([routesFactory])
        .withOptions({ mountRoute: "/api" })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/greet/World"));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ greeting: "Hello, World", key: "test-key" });
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
