import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { defineFragment, type FragmentDefinition } from "./fragment-definition-builder";
import type { FragnoPublicConfig } from "./shared-types";
import type { RequestThisContext } from "./api";

describe("FragmentDefinitionBuilder", () => {
  describe("defineFragment", () => {
    it("should create a basic fragment builder", () => {
      const builder = defineFragment("test-fragment");
      expect(builder.name).toBe("test-fragment");
    });

    it("should build a minimal definition", () => {
      const definition = defineFragment("test-fragment").build();

      expect(definition.name).toBe("test-fragment");
      expect(definition.dependencies).toBeUndefined();
      expect(definition.baseServices).toBeUndefined();
      expect(definition.namedServices).toBeUndefined();
      expect(definition.serviceDependencies).toBeUndefined();
    });
  });

  describe("withDependencies", () => {
    it("should define dependencies", () => {
      interface Config {
        apiKey: string;
      }

      const definition = defineFragment<Config>("test-fragment")
        .withDependencies(({ config, options }) => ({
          apiKey: config.apiKey,
          mountRoute: options.mountRoute,
        }))
        .build();

      expect(definition.dependencies).toBeDefined();

      // Test the dependencies function
      const deps = definition.dependencies!({
        config: { apiKey: "test-key" },
        options: { mountRoute: "/api" },
      });

      expect(deps.apiKey).toBe("test-key");
      expect(deps.mountRoute).toBe("/api");
    });

    it("should reset services when setting dependencies", () => {
      const definition = defineFragment("test-fragment")
        .providesBaseService(() => ({
          method1: () => "test",
        }))
        .withDependencies(() => ({
          dep1: "value",
        }))
        .build();

      // Base services should be reset
      expect(definition.baseServices).toBeUndefined();
      expect(definition.dependencies).toBeDefined();
    });

    it("should reset request storage and context when called late in chain", () => {
      // This demonstrates that calling withDependencies late erases earlier storage/context setup
      const definition = defineFragment("test-fragment")
        .withRequestStorage(() => ({
          counter: 0,
          userId: "user-123",
        }))
        .withRequestThisContext(({ storage }) => ({
          get counter() {
            return storage.getStore()?.counter ?? 0;
          },
          get userId() {
            return storage.getStore()?.userId;
          },
        }))
        // Calling withDependencies here will erase the storage and context configuration!
        .withDependencies(() => ({
          apiKey: "secret",
        }))
        .build();

      // Storage and context should be reset (undefined)
      expect(definition.createRequestStorage).toBeUndefined();
      expect(definition.createRequestContext).toBeUndefined();
      expect(definition.getExternalStorage).toBeUndefined();
      expect(definition.dependencies).toBeDefined();
    });

    it("should preserve storage and context when dependencies set early", () => {
      // This is the recommended pattern: set dependencies first
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({
          apiKey: "secret",
        }))
        .withRequestStorage(({ deps }) => ({
          counter: 0,
          apiKey: deps.apiKey,
        }))
        .withRequestThisContext(({ storage }) => ({
          get counter() {
            return storage.getStore()?.counter ?? 0;
          },
        }))
        .build();

      // Everything should be preserved
      expect(definition.createRequestStorage).toBeDefined();
      expect(definition.createRequestContext).toBeDefined();
      expect(definition.dependencies).toBeDefined();
    });

    it("should warn when withDependencies is called after storage/services are configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      defineFragment("test-fragment")
        .withRequestStorage(() => ({ counter: 0 }))
        .providesService("myService", () => ({ test: () => "hi" }))
        .withDependencies(() => ({ apiKey: "secret" }));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[Fragno] Warning: withDependencies() on fragment "test-fragment" is resetting',
        ),
      );

      warnSpy.mockRestore();
    });

    it("should not warn when withDependencies is called early", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "secret" }))
        .withRequestStorage(() => ({ counter: 0 }))
        .providesService("myService", () => ({ test: () => "hi" }));

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe("providesBaseService", () => {
    it("should define unnamed services", () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .providesBaseService(({ deps }) => ({
          method1: () => `${deps.apiKey}-method1`,
          method2: () => "method2",
        }))
        .build();

      expect(definition.baseServices).toBeDefined();

      // Test the services function
      const services = definition.baseServices!({
        config: {},
        options: {},
        deps: { apiKey: "test-key" },
        serviceDeps: {},
        defineService: (svc) => svc,
      });

      expect(services.method1()).toBe("test-key-method1");
      expect(services.method2()).toBe("method2");
    });

    it("should define unnamed services with defineService", () => {
      interface Bla extends RequestThisContext {
        myThisNumber: number;
        myThisString: string;
      }

      const definition = defineFragment<{}, FragnoPublicConfig, Bla>("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .providesBaseService(({ deps, defineService }) =>
          defineService({
            method1: function () {
              this.myThisNumber++;
              expectTypeOf(this).toMatchObjectType<{
                myThisNumber: number;
                myThisString: string;
              }>();
              return `${deps.apiKey}-method1`;
            },
          }),
        )
        .build();

      expect(definition.baseServices).toBeDefined();
    });
  });

  describe("providesService", () => {
    it("should define named services", () => {
      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .providesService("email", ({ deps }) => ({
          send: (to: string) => `Sending to ${to} with ${deps.apiKey}`,
        }))
        .build();

      expect(definition.namedServices).toBeDefined();
      expect(definition.namedServices!.email).toBeDefined();

      // Test the service function
      const emailService = definition.namedServices!.email({
        config: {},
        options: {},
        deps: { apiKey: "test-key" },
        serviceDeps: {},
        defineService: (svc) => svc,
      });

      expect(emailService.send("user@example.com")).toBe(
        "Sending to user@example.com with test-key",
      );
    });

    it("should support multiple named services", () => {
      const definition = defineFragment("test-fragment")
        .providesService("email", () => ({
          send: () => "email sent",
        }))
        .providesService("sms", () => ({
          send: () => "sms sent",
        }))
        .build();

      expect(definition.namedServices!.email).toBeDefined();
      expect(definition.namedServices!.sms).toBeDefined();

      const emailService = definition.namedServices!.email({
        config: {},
        options: {},
        deps: {},
        serviceDeps: {},
        defineService: (svc) => svc,
      });
      const smsService = definition.namedServices!.sms({
        config: {},
        options: {},
        deps: {},
        serviceDeps: {},
        defineService: (svc) => svc,
      });

      expect(emailService.send()).toBe("email sent");
      expect(smsService.send()).toBe("sms sent");
    });
  });

  describe("usesService", () => {
    it("should declare required service dependency", () => {
      interface EmailService {
        send: (to: string) => void;
      }

      const definition = defineFragment("test-fragment")
        .usesService<"email", EmailService>("email")
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies!.email).toEqual({
        name: "email",
        required: true,
      });
    });

    it("should declare optional service dependency", () => {
      interface LogService {
        log: (msg: string) => void;
      }

      const definition = defineFragment("test-fragment")
        .usesOptionalService<"logger", LogService>("logger")
        .build();

      expect(definition.serviceDependencies!.logger).toEqual({
        name: "logger",
        required: false,
      });
    });

    it("should support multiple service dependencies", () => {
      interface EmailService {
        send: (to: string) => void;
      }
      interface LogService {
        log: (msg: string) => void;
      }

      const definition = defineFragment("test-fragment")
        .usesService<"email", EmailService>("email")
        .usesOptionalService<"logger", LogService>("logger")
        .build();

      expect(definition.serviceDependencies!.email.required).toBe(true);
      expect(definition.serviceDependencies!.logger.required).toBe(false);
    });

    it("should allow services to use service dependencies", () => {
      interface EmailService {
        send: (to: string) => string;
      }

      const definition = defineFragment("test-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .usesService<"email", EmailService>("email")
        .providesBaseService(({ deps, serviceDeps }) => ({
          sendWelcome: () => {
            // serviceDeps should have email
            return serviceDeps.email.send("welcome@example.com");
          },
          getKey: () => deps.apiKey,
        }))
        .build();

      // Test with mock email service
      const services = definition.baseServices!({
        config: {},
        options: {},
        deps: { apiKey: "test-key" },
        serviceDeps: {
          email: {
            send: (to: string) => `Email sent to ${to}`,
          },
        },
        defineService: (svc) => svc,
      });

      expect(services.sendWelcome()).toBe("Email sent to welcome@example.com");
      expect(services.getKey()).toBe("test-key");
    });
  });

  describe("complex scenarios", () => {
    it("should support full fragment definition", () => {
      interface Config {
        apiKey: string;
        debug: boolean;
      }

      interface LogService {
        log: (msg: string) => void;
      }

      const definition = defineFragment<Config>("complex-fragment")
        .withDependencies(({ config }) => ({
          apiKey: config.apiKey,
          debug: config.debug,
        }))
        .usesOptionalService<"logger", LogService>("logger")
        .providesBaseService(({ deps, serviceDeps }) => ({
          getData: () => {
            if (serviceDeps.logger) {
              serviceDeps.logger.log("Getting data");
            }
            return `data-${deps.apiKey}`;
          },
        }))
        .providesService("analytics", ({ deps }) => ({
          track: (event: string) => `Tracking ${event} with ${deps.apiKey}`,
        }))
        .build();

      expect(definition.name).toBe("complex-fragment");
      expect(definition.dependencies).toBeDefined();
      expect(definition.baseServices).toBeDefined();
      expect(definition.namedServices).toBeDefined();
      expect(definition.serviceDependencies).toBeDefined();

      // Test execution
      const logs: string[] = [];
      const deps = definition.dependencies!({
        config: { apiKey: "my-key", debug: true },
        options: {},
      });

      const services = definition.baseServices!({
        config: { apiKey: "my-key", debug: true },
        options: {},
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        defineService: (svc) => svc,
      });

      const analyticsService = definition.namedServices!.analytics({
        config: { apiKey: "my-key", debug: true },
        options: {},
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        defineService: (svc) => svc,
      });

      expect(services.getData()).toBe("data-my-key");
      expect(logs).toContain("Getting data");
      expect(analyticsService.track("click")).toBe("Tracking click with my-key");
    });
  });

  describe("type safety", () => {
    it("should infer correct types", () => {
      interface Config {
        port: number;
      }

      const builder = defineFragment<Config>("typed-fragment")
        .withDependencies(({ config }) => ({
          port: config.port,
        }))
        .providesService("server", ({ deps }) => ({
          start: () => `Server starting on port ${deps.port}`,
        }));

      const definition = builder.build();

      // Type check: definition should have correct structure
      type DefType = typeof definition;
      const _typeCheck: DefType extends FragmentDefinition<
        Config,
        FragnoPublicConfig,
        { port: number },
        {},
        { server: { start: () => string } },
        {},
        RequestThisContext
      >
        ? true
        : false = true;

      expect(_typeCheck).toBe(true);
    });
  });

  describe("extend", () => {
    it("should allow extending builder with transformation function", () => {
      const builder = defineFragment("test");

      // Simple transformation that wraps the builder
      const extended = builder.extend((b) => ({
        builder: b,
        additionalMethod: () => "extended",
      }));

      expect(extended.builder).toBe(builder);
      expect(extended.additionalMethod()).toBe("extended");
    });

    it("should pass correct type through transformer", () => {
      interface Config {
        apiKey: string;
      }

      const builder = defineFragment<Config>("test").withDependencies(({ config }) => ({
        key: config.apiKey,
      }));

      // Transformer that returns a new builder type
      const extended = builder.extend((b) => {
        const def = b.build();
        return {
          definition: def,
          name: def.name,
        };
      });

      expect(extended.name).toBe("test");
      expect(extended.definition.name).toBe("test");
    });
  });
});
