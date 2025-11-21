import { describe, test, expect, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-definition-builder";
import { instantiate } from "./fragment-instantiator";

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
      const definition = defineFragment("test-fragment")
        .usesService<"email", IEmailService>("email")
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies?.email).toEqual({ name: "email", required: true });
    });

    test("should declare optional service with usesOptionalService", () => {
      const definition = defineFragment("test-fragment")
        .usesOptionalService<"email", IEmailService>("email")
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies?.email).toEqual({ name: "email", required: false });
    });

    test("should support multiple required services", () => {
      const definition = defineFragment("test-fragment")
        .usesService<"email", IEmailService>("email")
        .usesService<"logger", ILogger>("logger")
        .build();

      expect(definition.serviceDependencies?.email).toEqual({ name: "email", required: true });
      expect(definition.serviceDependencies?.logger).toEqual({ name: "logger", required: true });
    });

    test("should support mixing required and optional services", () => {
      const definition = defineFragment("test-fragment")
        .usesService<"email", IEmailService>("email")
        .usesOptionalService<"logger", ILogger>("logger")
        .build();

      expect(definition.serviceDependencies?.email).toEqual({ name: "email", required: true });
      expect(definition.serviceDependencies?.logger).toEqual({ name: "logger", required: false });
    });

    test("should preserve other fragment properties", () => {
      const definition = defineFragment<{ apiKey: string }>("test-fragment")
        .withDependencies(() => ({ dep: "value" }))
        .usesService<"email", IEmailService>("email")
        .build();

      expect(definition.name).toBe("test-fragment");
      expect(definition.serviceDependencies?.email).toBeDefined();
    });

    test("should have correct type inference for required service", () => {
      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .build();

      expect(definition.serviceDependencies?.email).toBeDefined();
      expect(definition.serviceDependencies?.email?.required).toBe(true);
    });

    test("should have correct type inference for optional service", () => {
      const definition = defineFragment("test")
        .usesOptionalService<"logger", ILogger>("logger")
        .build();

      expect(definition.serviceDependencies?.logger).toBeDefined();
      expect(definition.serviceDependencies?.logger?.required).toBe(false);
    });
  });

  describe("providesService", () => {
    test("should declare provided service implementation", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test-fragment")
        .providesService("email", () => emailImpl)
        .build();

      expect(definition.namedServices).toBeDefined();
    });

    test("should support multiple provided services", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const loggerImpl: ILogger = {
        log: () => {},
      };

      const _definition = defineFragment("test-fragment")
        .providesService("email", () => emailImpl)
        .providesService("logger", () => loggerImpl)
        .build();
    });
  });

  describe("Service metadata", () => {
    test("should store service metadata in definition", () => {
      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .usesOptionalService<"logger", ILogger>("logger")
        .build();

      expect(definition.serviceDependencies?.email?.required).toBe(true);
      expect(definition.serviceDependencies?.logger?.required).toBe(false);
    });

    test("should store provided services in definition", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .providesService("email", () => emailImpl)
        .build();

      expect(typeof definition.namedServices).toBe("object");
    });

    test("should allow fragments without any services", () => {
      const definition = defineFragment("test").build();

      expect(definition.serviceDependencies).toBeUndefined();
      expect(definition.namedServices).toBeUndefined();
    });
  });

  describe("Type safety", () => {
    test("Unnamed services should have correct types (using providesBaseService)", () => {
      const definition = defineFragment("test")
        .providesBaseService(() => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types", () => {
      const definition = defineFragment("test")
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using factory)", () => {
      const definition = defineFragment("test")
        .providesBaseService(() => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using callback with context)", () => {
      const definition = defineFragment("test")
        .providesBaseService(() => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Unnamed services should have correct types (using 0-arity factory)", () => {
      const definition = defineFragment("test")
        .providesBaseService(() => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types (using factory)", () => {
      const definition = defineFragment("test")
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("usesService (required)", () => {
      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          sendEmail: (to: string, subject: string, body: string) => {
            return serviceDeps.email.sendEmail(to, subject, body);
          },
        }))
        .build();

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const instance = instantiate(definition)
        .withOptions({})
        .withServices({ email: emailImpl })
        .build();

      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<
        (to: string, subject: string, body: string) => void
      >();
    });

    test("usesService (required) - builder style", () => {
      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          sendEmail: (to: string, subject: string, body: string) => {
            return serviceDeps.email.sendEmail(to, subject, body);
          },
        }))
        .build();

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const instance = instantiate(definition)
        .withServices({ email: emailImpl })
        .withOptions({})
        .build();

      expect(instance.services.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.sendEmail>().toExtend<
        (to: string, subject: string, body: string) => void
      >();
    });

    test("usesOptionalService", () => {
      const definition = defineFragment("test")
        .usesOptionalService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          sendEmail: serviceDeps.email
            ? (to: string, subject: string, body: string) =>
                serviceDeps.email!.sendEmail(to, subject, body)
            : undefined,
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      // For optional services, the wrapped service method might be undefined
      expect(instance.services.sendEmail).toBeUndefined();
    });

    test("provided services should have correct types", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .providesService("email", () => emailImpl)
        .build();

      // namedServices stores an object with service names as keys and factory functions as values
      expect(definition.namedServices).toBeDefined();
      expect(typeof definition.namedServices).toBe("object");
    });

    test("Named services should have correct types (using callback with context)", () => {
      const definition = defineFragment("test")
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Named services should have correct types (using 0-arity factory)", () => {
      const definition = defineFragment("test")
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.email.sendEmail).toBeDefined();
      expectTypeOf<typeof instance.services.email.sendEmail>().toExtend<() => Promise<void>>();
    });

    test("Type mismatch when using a service", () => {
      interface ExpectedService {
        throwDice: () => 1 | 2 | 3 | 4 | 5 | 6;
      }

      const definition = defineFragment("test")
        .usesService<"expected", ExpectedService>("expected")
        .providesBaseService(({ serviceDeps }) => ({
          throwDice: () => serviceDeps.expected.throwDice(),
        }))
        .build();

      interface ActualService {
        throwDice: () => number;
      }

      const actualService: ActualService = {
        throwDice: () => 1,
      };

      const instance = instantiate(definition)
        // @ts-expect-error - Type mismatch
        .withServices({ expected: actualService })
        .withOptions({})
        .build();

      // The wrapped service on the instance has the correct type based on the declared service
      expect(instance.services.throwDice).toBeDefined();
      expectTypeOf<typeof instance.services.throwDice>().toExtend<() => 1 | 2 | 3 | 4 | 5 | 6>();
    });
  });

  describe("Error handling", () => {
    test("should throw error when required service is not provided", () => {
      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .build();

      expect(() => {
        instantiate(definition).withOptions({}).build();
      }).toThrow("Fragment 'test' requires service 'email' but it was not provided");
    });

    test("should not throw when optional service is not provided", () => {
      const definition = defineFragment("test")
        .usesOptionalService<"email", IEmailService>("email")
        .build();

      expect(() => {
        instantiate(definition).withOptions({}).build();
      }).not.toThrow();
    });
  });

  describe("Service dependencies and composition", () => {
    test("provided service can access used services", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          sendWelcomeEmail: async (to: string) => {
            await serviceDeps.email.sendEmail(to, "Welcome", "Welcome to our service!");
          },
        }))
        .build();

      const instance = instantiate(definition)
        .withOptions({})
        .withServices({ email: emailImpl })
        .build();

      expect(instance.services.sendWelcomeEmail).toBeDefined();
      expect(typeof instance.services.sendWelcomeEmail).toBe("function");
    });

    test("provided service can access used services - builder style", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          sendWelcomeEmail: async (to: string) => {
            await serviceDeps.email.sendEmail(to, "Welcome", "Welcome to our service!");
          },
        }))
        .build();

      const instance = instantiate(definition)
        .withServices({ email: emailImpl })
        .withOptions({})
        .build();

      expect(instance.services.sendWelcomeEmail).toBeDefined();
      expect(typeof instance.services.sendWelcomeEmail).toBe("function");
    });

    test("provided service can access config", () => {
      const definition = defineFragment<{ apiKey: string }>("test")
        .providesBaseService(({ config }) => ({
          getApiKey: () => config.apiKey,
        }))
        .build();

      const instance = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withOptions({})
        .build();

      expect(instance.services.getApiKey()).toBe("test-key");
    });

    test("provided service can access deps from withDependencies", () => {
      const definition = defineFragment<{ apiKey: string }>("test")
        .withDependencies(({ config }) => ({
          client: { key: config.apiKey },
        }))
        .providesBaseService(({ deps }) => ({
          getClient: () => deps.client,
        }))
        .build();

      const instance = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withOptions({})
        .build();

      expect(instance.services.getClient()).toEqual({ key: "test-key" });
    });
  });

  describe("Service chaining and multiple services", () => {
    test("should support chaining multiple provided services", () => {
      const definition = defineFragment("test")
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .providesService("logger", () => ({
          log: () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.email.sendEmail).toBeDefined();
      expect(instance.services.logger.log).toBeDefined();
    });

    test("should support mixing unnamed and named provided services", () => {
      const definition = defineFragment("test")
        .providesBaseService(() => ({
          helper: () => "help",
        }))
        .providesService("email", () => ({
          sendEmail: async () => {},
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();
      expect(instance.services.helper).toBeDefined();
      expect(instance.services.email.sendEmail).toBeDefined();
    });
  });

  describe("Optional service runtime behavior", () => {
    test("should handle optional service when not provided", () => {
      const definition = defineFragment("test")
        .usesOptionalService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          maybeSendEmail: async (to: string) => {
            if (serviceDeps.email) {
              await serviceDeps.email.sendEmail(to, "Subject", "Body");
              return true;
            }
            return false;
          },
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      expect(instance.services.maybeSendEmail).toBeDefined();
      // Should not throw when optional service is not provided
    });

    test("should handle optional service when provided", () => {
      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .usesOptionalService<"email", IEmailService>("email")
        .providesBaseService(({ serviceDeps }) => ({
          maybeSendEmail: async (to: string) => {
            if (serviceDeps.email) {
              await serviceDeps.email.sendEmail(to, "Subject", "Body");
              return true;
            }
            return false;
          },
        }))
        .build();

      const instance = instantiate(definition)
        .withOptions({})
        .withServices({ email: emailImpl })
        .build();

      expect(instance.services.maybeSendEmail).toBeDefined();
      // When the optional service is provided, the wrapped method should work
      expect(typeof instance.services.maybeSendEmail).toBe("function");
    });
  });

  describe("Private Services", () => {
    test("private service should be accessible when defining other services", () => {
      interface IDataStore {
        get(key: string): string | undefined;
        set(key: string, value: string): void;
      }

      const dataStoreImpl: IDataStore = {
        get: () => "cached-value",
        set: () => {},
      };

      const definition = defineFragment("test")
        .providesPrivateService("dataStore", () => dataStoreImpl)
        .providesBaseService(({ privateServices }) => ({
          getValue: (key: string) => {
            // Private service is accessible here
            return privateServices.dataStore.get(key);
          },
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      // Private service should NOT be accessible on the instance
      expectTypeOf<typeof instance.services>().not.toMatchTypeOf<{ dataStore: IDataStore }>();

      // But the public service that uses it should work
      expect(instance.services.getValue).toBeDefined();
      expect(instance.services.getValue("test")).toBe("cached-value");
    });

    test("private service should NOT be exposed on fragment instance", () => {
      interface IInternalCache {
        cache: Map<string, unknown>;
      }

      const definition = defineFragment("test")
        .providesPrivateService<"cache", IInternalCache>("cache", () => ({
          cache: new Map(),
        }))
        .providesBaseService(({ privateServices }) => ({
          getCacheSize: () => privateServices.cache.cache.size,
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      // @ts-expect-error - Private service should not be accessible
      expect(instance.services.cache).toBeUndefined();

      // Only the public service should be accessible
      expect(instance.services.getCacheSize).toBeDefined();
    });

    test("multiple private services should work together", () => {
      interface ILogger {
        log(msg: string): void;
      }

      interface ICache {
        get(key: string): unknown;
      }

      const logger: ILogger = {
        log: () => {},
      };

      const cache: ICache = {
        get: () => "cached",
      };

      const definition = defineFragment("test")
        .providesPrivateService("logger", () => logger)
        .providesPrivateService("cache", () => cache)
        .providesBaseService(({ privateServices }) => ({
          getCachedValue: (key: string) => {
            privateServices.logger.log(`Getting ${key}`);
            return privateServices.cache.get(key);
          },
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      expect(instance.services.getCachedValue).toBeDefined();
      expect(instance.services.getCachedValue("test")).toBe("cached");
    });

    test("private services can access config and deps", () => {
      const definition = defineFragment<{ apiKey: string }>("test")
        .withDependencies(({ config }) => ({
          endpoint: `https://api.example.com/${config.apiKey}`,
        }))
        .providesPrivateService("internalApi", ({ deps }) => ({
          makeRequest: () => `${deps.endpoint}/request`,
        }))
        .providesBaseService(({ privateServices }) => ({
          doRequest: () => privateServices.internalApi.makeRequest(),
        }))
        .build();

      const instance = instantiate(definition)
        .withConfig({ apiKey: "test-key" })
        .withOptions({})
        .build();

      expect(instance.services.doRequest()).toBe("https://api.example.com/test-key/request");
    });

    test("private services can access serviceDeps", () => {
      interface IEmailService {
        sendEmail(to: string): Promise<void>;
      }

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const definition = defineFragment("test")
        .usesService<"email", IEmailService>("email")
        .providesPrivateService("emailHelper", ({ serviceDeps }) => ({
          sendWelcomeEmail: (to: string) => serviceDeps.email.sendEmail(to),
        }))
        .providesBaseService(({ privateServices }) => ({
          welcomeUser: (email: string) => privateServices.emailHelper.sendWelcomeEmail(email),
        }))
        .build();

      const instance = instantiate(definition)
        .withServices({ email: emailImpl })
        .withOptions({})
        .build();

      expect(instance.services.welcomeUser).toBeDefined();
      expectTypeOf<typeof instance.services.welcomeUser>().toExtend<
        (email: string) => Promise<void>
      >();
    });

    test("named services can also access private services", () => {
      const definition = defineFragment("test")
        .providesPrivateService("helper", () => ({
          multiply: (a: number, b: number) => a * b,
        }))
        .providesService("calculator", ({ privateServices }) => ({
          square: (n: number) => privateServices.helper.multiply(n, n),
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      expect(instance.services.calculator.square(5)).toBe(25);
      // @ts-expect-error - Private service should not be accessible
      expect(instance.services.helper).toBeUndefined();
    });

    test("private services can access other private services (in order)", () => {
      const definition = defineFragment("test")
        .providesPrivateService("math", () => ({
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        }))
        .providesPrivateService("calculator", ({ privateServices }) => ({
          // This private service can access the earlier private service
          square: (n: number) => privateServices.math.multiply(n, n),
          addTen: (n: number) => privateServices.math.add(n, 10),
        }))
        .providesBaseService(({ privateServices }) => ({
          compute: (n: number) => {
            // Public service can access both private services
            const squared = privateServices.calculator.square(n);
            return privateServices.calculator.addTen(squared);
          },
        }))
        .build();

      const instance = instantiate(definition).withOptions({}).build();

      // 5^2 = 25, 25 + 10 = 35
      expect(instance.services.compute(5)).toBe(35);

      // Private services should not be accessible on the instance
      // @ts-expect-error - Private service should not be accessible
      expect(instance.services.math).toBeUndefined();
      // @ts-expect-error - Private service should not be accessible
      expect(instance.services.calculator).toBeUndefined();
    });
  });
});
