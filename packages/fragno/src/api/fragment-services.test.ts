import { describe, test, expect, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-builder";
import { createFragment, instantiateFragment } from "./fragment-instantiation";

// Test service interface definitions
interface IEmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

interface ILogger {
  log(message: string): void;
}

describe("Fragment Service System", () => {
  describe("usesService", () => {
    test("should declare required service by default", () => {
      const fragment = defineFragment<{}>("test-fragment").usesService<"email", IEmailService>(
        "email",
      );

      expect(fragment.definition.usedServices).toBeDefined();
      expect(fragment.definition.usedServices?.email).toEqual({ name: "email", required: true });
    });

    test("should declare optional service with { optional: true }", () => {
      const fragment = defineFragment<{}>("test-fragment").usesService<"email", IEmailService>(
        "email",
        { optional: true },
      );

      expect(fragment.definition.usedServices).toBeDefined();
      expect(fragment.definition.usedServices?.email).toEqual({ name: "email", required: false });
    });

    test("should support multiple required services", () => {
      const fragment = defineFragment<{}>("test-fragment")
        .usesService<"email", IEmailService>("email")
        .usesService<"logger", ILogger>("logger");

      expect(fragment.definition.usedServices?.email).toEqual({ name: "email", required: true });
      expect(fragment.definition.usedServices?.logger).toEqual({ name: "logger", required: true });
    });

    test("should support mixing required and optional services", () => {
      const fragment = defineFragment<{}>("test-fragment")
        .usesService<"email", IEmailService>("email")
        .usesService<"logger", ILogger>("logger", { optional: true });

      expect(fragment.definition.usedServices?.email).toEqual({ name: "email", required: true });
      expect(fragment.definition.usedServices?.logger).toEqual({ name: "logger", required: false });
    });

    test("should preserve other fragment properties", () => {
      const fragment = defineFragment<{ apiKey: string }>("test-fragment")
        .withDependencies(() => ({ dep: "value" }))
        .usesService<"email", IEmailService>("email");

      expect(fragment.definition.name).toBe("test-fragment");
      expect(fragment.definition.usedServices?.email).toBeDefined();
    });

    test("should have correct type inference for required service", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      expectTypeOf(fragment).toMatchTypeOf<{
        definition: {
          usedServices?: {
            email: { name: string; required: boolean };
          };
        };
      }>();
    });

    test("should have correct type inference for optional service", () => {
      const fragment = defineFragment<{}>("test").usesService<"logger", ILogger>("logger", {
        optional: true,
      });

      expectTypeOf(fragment).toMatchTypeOf<{
        definition: {
          usedServices?: {
            logger: { name: string; required: boolean };
          };
        };
      }>();
    });
  });

  describe("providesService", () => {
    test("should declare provided service implementation", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test-fragment").providesService(
        "email",
        ({ defineService }) => defineService(emailImpl),
      );

      expect(fragment.definition.providedServices).toBeDefined();
    });

    test("should support multiple provided services", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const loggerImpl: ILogger = {
        log: () => {},
      };

      const _fragment = defineFragment<{}>("test-fragment")
        .providesService("email", ({ defineService }) => defineService(emailImpl))
        .providesService("logger", ({ defineService }) => defineService(loggerImpl));
    });
  });

  describe("Service metadata", () => {
    test("should store service metadata in definition", () => {
      const fragment = defineFragment<{}>("test")
        .usesService<"email", IEmailService>("email")
        .usesService<"logger", ILogger>("logger", { optional: true });

      expect(fragment.definition.usedServices?.email?.required).toBe(true);
      expect(fragment.definition.usedServices?.logger?.required).toBe(false);
    });

    test("should store provided services in definition", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test").providesService("email", ({ defineService }) =>
        defineService(emailImpl),
      );

      expect(typeof fragment.definition.providedServices).toBe("object");
    });

    test("should allow fragments without any services", () => {
      const fragment = defineFragment<{}>("test");

      expect(fragment.definition.usedServices).toBeUndefined();
      expect(fragment.definition.providedServices).toBeUndefined();
    });
  });

  describe("Type safety", () => {
    test("Unnamed services should have correct types (using defineService)", () => {
      const fragment = defineFragment<{}>("test").providesService(({ defineService }) =>
        defineService({
          sendEmail: async () => {},
        }),
      );

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types (using defineService)", () => {
      const fragment = defineFragment<{}>("test").providesService("email", ({ defineService }) =>
        defineService({
          sendEmail: async () => {},
        }),
      );

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using object)", () => {
      const fragment = defineFragment<{}>("test").providesService({
        sendEmail: async () => {},
      });

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using callback with context)", () => {
      const fragment = defineFragment<{}>("test").providesService(({ defineService }) =>
        defineService({
          sendEmail: async () => {},
        }),
      );

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using 0-arity factory)", () => {
      const fragment = defineFragment<{}>("test").providesService(() => ({
        sendEmail: async () => {},
      }));

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types (using object)", () => {
      const fragment = defineFragment<{}>("test").providesService("email", {
        sendEmail: async () => {},
      });

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("usesService (required)", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const instance = createFragment(
        fragment,
        {},
        [],
        {},
        {
          email: emailImpl,
        },
      );

      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<
        (to: string, subject: string, body: string) => void
      >();
    });

    test("usesService (required) - builder style", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const instance = instantiateFragment(fragment).withServices({ email: emailImpl }).build();

      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<
        (to: string, subject: string, body: string) => void
      >();
    });

    test("usesService (optional)", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email", {
        optional: true,
      });

      const instance = createFragment(fragment, {}, [], {});
      // For optional services, the service itself might be undefined
      expectTypeOf<typeof instance.services.email>().toExtend<IEmailService | undefined>();

      // If provided, the service should have the correct type
      if (instance.services.email) {
        expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<
          (to: string, subject: string, body: string) => Promise<void>
        >();
      }
    });

    test("provided services should have correct types", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test").providesService("email", ({ defineService }) =>
        defineService(emailImpl),
      );

      // providedServices stores an object with service names as keys and factory functions as values
      expect(fragment.definition.providedServices).toBeDefined();
      expect(typeof fragment.definition.providedServices).toBe("object");
    });

    test("Named services should have correct types (using callback with context)", () => {
      const fragment = defineFragment<{}>("test").providesService("email", ({ defineService }) =>
        defineService({
          sendEmail: async () => {},
        }),
      );

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types (using 0-arity factory)", () => {
      const fragment = defineFragment<{}>("test").providesService("email", () => ({
        sendEmail: async () => {},
      }));

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });
  });

  describe("Error handling", () => {
    test("should throw error when required service is not provided", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      expect(() => {
        createFragment(fragment, {}, [], {});
      }).toThrow("Fragment 'test' requires service 'email' but it was not provided");
    });

    test("should not throw when optional service is not provided", () => {
      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email", {
        optional: true,
      });

      expect(() => {
        createFragment(fragment, {}, [], {});
      }).not.toThrow();
    });
  });

  describe("Service dependencies and composition", () => {
    test("provided service can access used services", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test")
        .usesService<"email", IEmailService>("email")
        .providesService(({ deps }) => ({
          sendWelcomeEmail: async (to: string) => {
            await deps.email.sendEmail(to, "Welcome", "Welcome to our service!");
          },
        }));

      const instance = createFragment(fragment, {}, [], {}, { email: emailImpl });

      expect(instance.services.sendWelcomeEmail).toBeDefined();
      expect(typeof instance.services.sendWelcomeEmail).toBe("function");
    });

    test("provided service can access used services - builder style", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test")
        .usesService<"email", IEmailService>("email")
        .providesService(({ deps }) => ({
          sendWelcomeEmail: async (to: string) => {
            await deps.email.sendEmail(to, "Welcome", "Welcome to our service!");
          },
        }));

      const instance = instantiateFragment(fragment).withServices({ email: emailImpl }).build();

      expect(instance.services.sendWelcomeEmail).toBeDefined();
      expect(typeof instance.services.sendWelcomeEmail).toBe("function");
    });

    test("provided service can access config", () => {
      const fragment = defineFragment<{ apiKey: string }>("test").providesService(({ config }) => ({
        getApiKey: () => config.apiKey,
      }));

      const instance = createFragment(fragment, { apiKey: "test-key" }, [], {});

      expect(instance.services.getApiKey()).toBe("test-key");
    });

    test("provided service can access deps from withDependencies", () => {
      const fragment = defineFragment<{ apiKey: string }>("test")
        .withDependencies(({ config }) => ({
          client: { key: config.apiKey },
        }))
        .providesService(({ deps }) => ({
          getClient: () => deps.client,
        }));

      const instance = createFragment(fragment, { apiKey: "test-key" }, [], {});

      expect(instance.services.getClient()).toEqual({ key: "test-key" });
    });
  });

  describe("Service chaining and multiple services", () => {
    test("should support chaining multiple provided services", () => {
      const fragment = defineFragment<{}>("test")
        .providesService("email", {
          sendEmail: async () => {},
        })
        .providesService("logger", {
          log: () => {},
        });

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.email.sendEmail).toBeDefined();
      expect(instance.services.logger.log).toBeDefined();
    });

    test("should support mixing unnamed and named provided services", () => {
      const fragment = defineFragment<{}>("test")
        .providesService({
          helper: () => "help",
        })
        .providesService("email", {
          sendEmail: async () => {},
        });

      const instance = createFragment(fragment, {}, [], {});
      expect(instance.services.helper).toBeDefined();
      expect(instance.services.email.sendEmail).toBeDefined();
    });
  });

  describe("Optional service runtime behavior", () => {
    test("should handle optional service when not provided", () => {
      const fragment = defineFragment<{}>("test")
        .usesService<"email", IEmailService>("email", { optional: true })
        .providesService(({ deps }) => ({
          maybeSendEmail: async (to: string) => {
            if (deps.email) {
              await deps.email.sendEmail(to, "Subject", "Body");
              return true;
            }
            return false;
          },
        }));

      const instance = createFragment(fragment, {}, [], {});

      expect(instance.services.maybeSendEmail).toBeDefined();
      // Should not throw when optional service is not provided
    });

    test("should handle optional service when provided", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test")
        .usesService<"email", IEmailService>("email", { optional: true })
        .providesService(({ deps }) => ({
          maybeSendEmail: async (to: string) => {
            if (deps.email) {
              await deps.email.sendEmail(to, "Subject", "Body");
              return true;
            }
            return false;
          },
        }));

      const instance = createFragment(fragment, {}, [], {}, { email: emailImpl });

      expect(instance.services.email).toBeDefined();
      expect(instance.services.maybeSendEmail).toBeDefined();
    });
  });
});
