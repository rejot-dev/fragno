import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-definition-builder";
import {
  instantiate,
  instantiateFragment,
  FragnoInstantiatedFragment,
} from "./fragment-instantiator";
import { defineRoute, defineRoutes, type AnyFragmentDefinition } from "./route";
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

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
      expect(fragment.name).toBe("test-fragment");
      expect(fragment.routes).toHaveLength(1);
      expect(fragment.mountRoute).toBe("/api");
    });

    it("should instantiate without config or routes", () => {
      const definition = defineFragment("minimal-fragment").build();

      const fragment = instantiate(definition).build();

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
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

    it("should URL decode path params", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/users/:name",
        handler: async (input, { json }) => {
          return json({ userName: input.pathParams.name });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      // URL with encoded space: "a%20b" should be decoded to "a b"
      const request = new Request("http://localhost/api/users/a%20b");
      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ userName: "a b" });
    });

    it("should URL decode path params with special characters", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "GET",
        path: "/files/:path",
        handler: async (input, { json }) => {
          return json({ filePath: input.pathParams.path });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      // URL with encoded slash: "folder%2Fsubfolder" should be decoded to "folder/subfolder"
      const request = new Request("http://localhost/api/files/folder%2Fsubfolder");
      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ filePath: "folder/subfolder" });
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

    it("should accept FormData for routes with contentType: multipart/form-data", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "POST",
        path: "/upload",
        contentType: "multipart/form-data",
        handler: async (ctx, { json }) => {
          const formData = ctx.formData();
          const description = formData.get("description") as string;
          return json({ description });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const formData = new FormData();
      formData.append("description", "Test file upload");

      const request = new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ description: "Test file upload" });
    });

    it("should reject FormData for JSON routes (default contentType)", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "POST",
        path: "/json-only",
        inputSchema: z.object({ name: z.string() }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json(body);
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const formData = new FormData();
      formData.append("name", "test");

      const request = new Request("http://localhost/api/json-only", {
        method: "POST",
        body: formData,
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(415);
      const data = await response.json();
      expect(data.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("should reject JSON for FormData routes", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "POST",
        path: "/upload",
        contentType: "multipart/form-data",
        handler: async (ctx, { json }) => {
          // Verify formData() works (would throw if not FormData)
          ctx.formData();
          return json({ success: true });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(415);
      const data = await response.json();
      expect(data.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("should accept octet-stream for routes with contentType: application/octet-stream", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "PUT",
        path: "/stream",
        contentType: "application/octet-stream",
        handler: async (ctx, { json }) => {
          const stream = ctx.bodyStream();
          const text = await new Response(stream).text();
          return json({ received: text });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/stream", {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new TextEncoder().encode("hello"),
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ received: "hello" });
    });

    it("should reject JSON for octet-stream routes", async () => {
      const definition = defineFragment("test-fragment").build();

      const route = defineRoute({
        method: "PUT",
        path: "/stream",
        contentType: "application/octet-stream",
        handler: async (ctx, { json }) => {
          if (!ctx.isBodyStream()) {
            throw new Error("Expected stream body");
          }
          return json({ ok: true });
        },
      });

      const fragment = instantiate(definition)
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .build();

      const request = new Request("http://localhost/api/stream", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });

      const response = await fragment.handler(request);

      expect(response.status).toBe(415);
      const data = await response.json();
      expect(data.code).toBe("UNSUPPORTED_MEDIA_TYPE");
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
    it("should use custom thisContext from createThisContext", async () => {
      interface CustomThisContext extends RequestThisContext {
        customMethod: () => string;
      }

      const definition = defineFragment("test-fragment").build();

      // Manually add createThisContext to definition
      const definitionWithContext = {
        ...definition,
        createThisContext: () => {
          const ctx = {
            customMethod: () => "custom value",
          };
          return { serviceContext: ctx, handlerContext: ctx };
        },
      } satisfies AnyFragmentDefinition;

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
        .withThisContext(({ storage }) => {
          const ctx = {
            get requestId() {
              contextCreationSpy();
              return { text: "default", counter: ++storage.getStore().counter };
            },
          };
          return { serviceContext: ctx, handlerContext: ctx };
        })
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => {
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
    it("withThisContext types", () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key", number: 5 }))
        .withThisContext(() => {
          const ctx = {
            x: 3,
            y: "hello",
            get someNumber() {
              return 5;
            },
          };
          return { serviceContext: ctx, handlerContext: ctx };
        })
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

      // Type check: definition should have correct context factory
      expect(definition.createThisContext).toBeDefined();
    });

    it("withRequestStorage allows mutating stored data", async () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ startingCounter: 5 }))
        .withRequestStorage(({ deps }) => ({ counter: deps.startingCounter }))
        .withThisContext(({ storage }) => {
          const ctx = {
            // Getter to access current counter value from storage
            get counter() {
              return storage.getStore().counter;
            },
            // Method to increment the counter in storage
            incrementCounter() {
              storage.getStore().counter++;
            },
          };
          return { serviceContext: ctx, handlerContext: ctx };
        })
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => [
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
        .withThisContext(({ deps }) => {
          const ctx = {
            get someNumber() {
              return deps.number;
            },
          };
          return { serviceContext: ctx, handlerContext: ctx };
        })
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

      // Now let's use defineRoutes to access services properly in routes
      const routesFactory = defineRoutes(definition).create(({ services, defineRoute }) => {
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
        .withThisContext(() => {
          const ctx = {
            myThisNumber: 0,
            myThisString: "hello",
          };
          return { serviceContext: ctx, handlerContext: ctx };
        })
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

  describe("defineRoutes with services", () => {
    it("should provide base services in route factory context", () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          greet: (name: string) => `Hello, ${name}!`,
        }))
        .build();

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => {
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => {
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => {
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => [
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => {
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

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => {
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

  describe("linked fragments", () => {
    it("should instantiate linked fragments with the parent fragment", () => {
      interface Config {
        apiKey: string;
      }

      // Create a linked fragment definition
      const linkedFragmentDef = defineFragment<Config>("linked-fragment")
        .providesService("linkedService", () => ({
          getValue: () => "from-linked",
        }))
        .build();

      // Create main fragment with linked fragment
      const definition = defineFragment<Config>("main-fragment")
        .withLinkedFragment("internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef).withConfig(config).withOptions(options).build();
        })
        .build();

      const fragment = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withOptions({ mountRoute: "/api" })
        .build();

      // Verify linked fragment exists
      expect(Object.keys(fragment.$internal.linkedFragments).length).toBe(1);
      expect("internal" in fragment.$internal.linkedFragments).toBe(true);

      const linkedFragment = fragment.$internal.linkedFragments.internal;
      expect(linkedFragment).toBeDefined();
      expect(linkedFragment?.name).toBe("linked-fragment");
    });

    it("should mount internal linked fragment routes under /_internal", async () => {
      const linkedFragmentDef = defineFragment("linked-fragment").build();
      const linkedRoutes = defineRoutes(linkedFragmentDef).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/status",
          handler: async (_input, { json }) => {
            return json({ ok: true });
          },
        }),
      ]);

      const definition = defineFragment("main-fragment")
        .withLinkedFragment("_fragno_internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef)
            .withConfig(config)
            .withOptions(options)
            .withRoutes([linkedRoutes])
            .build();
        })
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      const response = await fragment.callRouteRaw("GET", "/_internal/status" as never);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("should run middleware set on the internal fragment", async () => {
      const linkedFragmentDef = defineFragment("linked-fragment").build();
      const linkedRoutes = defineRoutes(linkedFragmentDef).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/status",
          handler: async (_input, { json }) => {
            return json({ ok: true });
          },
        }),
      ]);

      const definition = defineFragment("main-fragment")
        .withLinkedFragment("_fragno_internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef)
            .withConfig(config)
            .withOptions(options)
            .withRoutes([linkedRoutes])
            .build();
        })
        .build();

      const fragment = instantiate(definition).withOptions({ mountRoute: "/api" }).build();

      const internalFragment = fragment.$internal.linkedFragments._fragno_internal;
      internalFragment.withMiddleware(async ({ ifMatchesRoute }) => {
        const result = await ifMatchesRoute("GET", "/status", async (_input, { json }) => {
          return json({ ok: false, source: "internal-middleware" }, 418);
        });

        return result;
      });

      const response = await fragment.handler(
        new Request("http://localhost/api/_internal/status", {
          method: "GET",
        }),
      );

      expect(response.status).toBe(418);
      expect(await response.json()).toEqual({ ok: false, source: "internal-middleware" });
    });

    it("should pass config and options to linked fragments", () => {
      interface Config {
        value: string;
      }

      interface Options extends FragnoPublicConfig {
        customOption: string;
      }

      const linkedFragmentDef = defineFragment<Config, Options>("linked-fragment")
        .withDependencies(({ config, options }) => ({
          combined: `${config.value}-${options.customOption}`,
        }))
        .build();

      const definition = defineFragment<Config, Options>("main-fragment")
        .withLinkedFragment("internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef).withConfig(config).withOptions(options).build();
        })
        .build();

      const fragment = instantiate(definition)
        .withConfig({ value: "config" })
        .withOptions({ customOption: "option", mountRoute: "/api" } as Options)
        .build();

      const linkedFragment = fragment.$internal.linkedFragments.internal;
      expect(linkedFragment?.$internal.deps).toEqual({
        combined: "config-option",
      });
    });

    it("should allow linked fragments to provide services", () => {
      const linkedFragmentDef = defineFragment("linked-fragment")
        .providesService("settingsService", () => ({
          get: (key: string) => `value-for-${key}`,
          set: (key: string, value: string) => {
            console.log(`Setting ${key} = ${value}`);
          },
        }))
        .build();

      const definition = defineFragment("main-fragment")
        .withLinkedFragment("internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef).withConfig(config).withOptions(options).build();
        })
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      const linkedFragment = fragment.$internal.linkedFragments.internal;
      expect(linkedFragment?.services.settingsService).toBeDefined();
      expect(linkedFragment?.services.settingsService.get("test")).toBe("value-for-test");
    });

    it("should support multiple linked fragments", () => {
      const linkedFragmentDef1 = defineFragment("linked-fragment-1")
        .providesService("service1", () => ({ method: () => "service1" }))
        .build();

      const linkedFragmentDef2 = defineFragment("linked-fragment-2")
        .providesService("service2", () => ({ method: () => "service2" }))
        .build();

      const definition = defineFragment("main-fragment")
        .withLinkedFragment("internal1", ({ config, options }) => {
          return instantiate(linkedFragmentDef1).withConfig(config).withOptions(options).build();
        })
        .withLinkedFragment("internal2", ({ config, options }) => {
          return instantiate(linkedFragmentDef2).withConfig(config).withOptions(options).build();
        })
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      expect(Object.keys(fragment.$internal.linkedFragments).length).toBe(2);
      expect("internal1" in fragment.$internal.linkedFragments).toBe(true);
      expect("internal2" in fragment.$internal.linkedFragments).toBe(true);

      const linked1 = fragment.$internal.linkedFragments.internal1;
      const linked2 = fragment.$internal.linkedFragments.internal2;

      expect(linked1?.services.service1.method()).toBe("service1");
      expect(linked2?.services.service2.method()).toBe("service2");
    });

    it("should pass service dependencies to linked fragments", () => {
      interface ExternalService {
        getValue: () => string;
      }

      const externalService: ExternalService = {
        getValue: () => "external-value",
      };

      const linkedFragmentDef = defineFragment("linked-fragment")
        .usesService<"externalService", ExternalService>("externalService")
        .providesService("linkedService", ({ serviceDeps }) => ({
          getFromExternal: () => serviceDeps.externalService.getValue(),
        }))
        .build();

      const definition = defineFragment("main-fragment")
        .usesService<"externalService", ExternalService>("externalService")
        .withLinkedFragment("internal", ({ config, options, serviceDependencies }) => {
          return instantiate(linkedFragmentDef)
            .withConfig(config)
            .withOptions(options)
            .withServices(serviceDependencies!)
            .build();
        })
        .build();

      const fragment = instantiate(definition)
        .withOptions({})
        .withServices({ externalService })
        .build();

      const linkedFragment = fragment.$internal.linkedFragments.internal;
      expect(linkedFragment?.services.linkedService.getFromExternal()).toBe("external-value");
    });

    it("should expose linked fragment services as private services", () => {
      const linkedFragmentDef = defineFragment("linked-fragment")
        .providesService("linkedService", () => ({
          getValue: () => "from-linked",
        }))
        .build();

      const definition = defineFragment("main-fragment")
        .withLinkedFragment("internal", ({ config, options }) => {
          return instantiate(linkedFragmentDef).withConfig(config).withOptions(options).build();
        })
        .providesService("mainService", ({ privateServices }) => ({
          getLinkedValue: () => {
            return privateServices.linkedService.getValue();
          },
        }))
        .build();

      const fragment = instantiate(definition).withOptions({}).build();

      // The main service can access linked fragment services via privateServices
      expect(fragment.services.mainService.getLinkedValue()).toBe("from-linked");

      // Linked fragment services are NOT directly exposed on the main fragment
      // @ts-expect-error - Linked fragment service should not be accessible
      expect(fragment.services.linkedService).toBeUndefined();
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

  describe("dry run mode", () => {
    it("should handle dependency errors in dry run mode", () => {
      interface Config {
        requiredKey: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => {
          if (!config.requiredKey) {
            throw new Error("Missing required key");
          }
          return { key: config.requiredKey };
        })
        .build();

      // Without dry run - should throw
      expect(() => {
        instantiateFragment(definition, {} as Config, [], {});
      }).toThrow("Missing required key");

      // With dry run - should succeed with stub deps
      const fragment = instantiateFragment(definition, {} as Config, [], {}, undefined, {
        dryRun: true,
      });

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
      expect(fragment.$internal.deps).toEqual({});
    });

    it("should handle service errors in dry run mode", () => {
      interface Config {
        value: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => {
          if (!config.value) {
            throw new Error("Missing value");
          }
          return { val: config.value };
        })
        .providesBaseService(({ deps }) => {
          if (!deps.val) {
            throw new Error("Missing deps.val");
          }
          return {
            getValue: () => deps.val,
          };
        })
        .build();

      // Without dry run - should throw during deps initialization
      expect(() => {
        instantiateFragment(definition, {} as Config, [], {});
      }).toThrow("Missing value");

      // With dry run - should succeed with stub services
      const fragment = instantiateFragment(definition, {} as Config, [], {}, undefined, {
        dryRun: true,
      });

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
      // Services should be empty objects in dry run
      expect(fragment.services).toBeDefined();
    });

    it("should handle named service errors in dry run mode", () => {
      interface Config {
        apiKey: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => {
          if (!config.apiKey) {
            throw new Error("Missing API key");
          }
          return { key: config.apiKey };
        })
        .providesService("apiService", ({ deps }) => {
          if (!deps.key) {
            throw new Error("Cannot create service without key");
          }
          return {
            call: () => `Calling with ${deps.key}`,
          };
        })
        .build();

      const fragment = instantiateFragment(definition, {} as Config, [], {}, undefined, {
        dryRun: true,
      });

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
      expect(fragment.services.apiService).toBeDefined();
      expect(fragment.services.apiService).toEqual({});
    });

    it("should handle private service errors in dry run mode", () => {
      interface Config {
        secret: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => {
          if (!config.secret) {
            throw new Error("Missing secret");
          }
          return { secret: config.secret };
        })
        .build();

      const fragment = instantiateFragment(definition, {} as Config, [], {}, undefined, {
        dryRun: true,
      });

      expect(fragment).toBeInstanceOf(FragnoInstantiatedFragment);
    });

    it("should not catch errors when dry run is disabled", () => {
      interface Config {
        key: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config }) => {
          if (!config.key) {
            throw new Error("Missing key");
          }
          return { key: config.key };
        })
        .build();

      expect(() => {
        instantiateFragment(definition, {} as Config, [], {}, undefined, { dryRun: false });
      }).toThrow("Missing key");
    });
  });
});
