import { describe, it, expect } from "vitest";
import { defineFragment, FragmentDefinitionBuilder } from "./fragment-definition-builder";
import type { FragnoPublicConfig } from "./shared-types";
import type { RequestThisContext } from "./api";

describe("FragmentDefinitionBuilder.extend()", () => {
  describe("basic functionality", () => {
    it("should allow extending with a simple transformer", () => {
      const addTimestamp = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { timestamp: () => number },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                timestamp: () => Date.now(),
              } as TBaseServices & { timestamp: () => number };
            },
          });
        };
      };

      const definition = defineFragment<{ enabled: boolean }>("test")
        .withDependencies(({ config }) => ({ enabled: config.enabled }))
        .extend(addTimestamp())
        .build();

      expect(definition.name).toBe("test");
      expect(definition.dependencies).toBeDefined();
      expect(definition.baseServices).toBeDefined();
    });

    it("should allow chaining multiple extend() calls", () => {
      const addCounter = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { counter: { value: number; increment: () => void } },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              let count = 0;
              return {
                ...existing,
                counter: {
                  value: count,
                  increment: () => {
                    count++;
                  },
                },
              } as TBaseServices & { counter: { value: number; increment: () => void } };
            },
          });
        };
      };

      const addLogger = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { logger: { log: (msg: string) => void } },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                logger: {
                  log: (_msg: string) => {
                    // In tests, we won't actually log
                  },
                },
              } as TBaseServices & { logger: { log: (msg: string) => void } };
            },
          });
        };
      };

      const definition = defineFragment<{ name: string }>("chained")
        .withDependencies(({ config }) => ({ name: config.name }))
        .extend(addCounter())
        .extend(addLogger())
        .build();

      expect(definition.name).toBe("chained");
      expect(definition.baseServices).toBeDefined();

      // Verify both extensions are present in the type
      const services = definition.baseServices!({
        config: { name: "test" },
        options: {},
        deps: { name: "test" },
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services).toHaveProperty("counter");
      expect(services).toHaveProperty("logger");
      expect(services.counter).toHaveProperty("value");
      expect(services.counter).toHaveProperty("increment");
      expect(services.logger).toHaveProperty("log");
    });
  });

  describe("ordering", () => {
    it("should apply extends in order - first extend's services available to second", () => {
      // First extension adds a base value
      const addBase = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { baseValue: number },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                baseValue: 42,
              } as TBaseServices & { baseValue: number };
            },
          });
        };
      };

      // Second extension uses the base value to compute a derived value
      const addDerived = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices extends { baseValue: number },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { derivedValue: number },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices!(context);
              return {
                ...existing,
                derivedValue: existing.baseValue * 2,
              } as TBaseServices & { derivedValue: number };
            },
          });
        };
      };

      const definition = defineFragment("ordered")
        .extend(addBase())
        .extend(addDerived()) // This depends on addBase being called first
        .build();

      const services = definition.baseServices!({
        config: {},
        options: {},
        deps: {},
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.baseValue).toBe(42);
      expect(services.derivedValue).toBe(84); // 42 * 2
    });

    it("withDependencies resets base services - extend before withDependencies is lost", () => {
      const addUtility = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { utility: { helper: () => string } },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                utility: {
                  helper: () => "helped",
                },
              } as TBaseServices & { utility: { helper: () => string } };
            },
          });
        };
      };

      // This demonstrates that withDependencies resets baseServices
      // So extending BEFORE withDependencies means the extension is lost
      const definition = defineFragment<{ key: string }>("early-extend")
        .extend(addUtility())
        .withDependencies(({ config }) => ({ key: config.key })) // This resets base services!
        .build();

      // Base services are undefined because withDependencies reset them
      expect(definition.baseServices).toBeUndefined();
    });

    it("should preserve types when extending after other builder methods", () => {
      const addFormatter = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { formatter: { format: (s: string) => string } },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                formatter: {
                  format: (s: string) => s.toUpperCase(),
                },
              } as TBaseServices & { formatter: { format: (s: string) => string } };
            },
          });
        };
      };

      // Add other things first, then extend
      const definition = defineFragment<{ prefix: string }>("late-extend")
        .withDependencies(({ config }) => ({ prefix: config.prefix }))
        .providesService("prefixer", ({ deps, defineService }) =>
          defineService({
            addPrefix: (s: string) => `${deps.prefix}-${s}`,
          }),
        )
        .extend(addFormatter())
        .build();

      // Dependencies should still work
      expect(definition.dependencies).toBeDefined();
      const deps = definition.dependencies!({ config: { prefix: "TEST" }, options: {} });
      expect(deps.prefix).toBe("TEST");

      // Named services should still work
      expect(definition.namedServices).toBeDefined();
      const namedService = definition.namedServices!.prefixer({
        config: { prefix: "TEST" },
        options: {},
        deps: { prefix: "TEST" },
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });
      expect(namedService.addPrefix("value")).toBe("TEST-value");

      // Extended base service should be present
      const services = definition.baseServices!({
        config: { prefix: "TEST" },
        options: {},
        deps: { prefix: "TEST" },
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });
      expect(services.formatter.format("hello")).toBe("HELLO");
    });
  });

  describe("type preservation", () => {
    it("should preserve all type parameters through extend", () => {
      type MyConfig = { value: number };
      type MyDeps = { computed: number };

      const addMath = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { math: { add: (a: number, b: number) => number } },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                math: {
                  add: (a: number, b: number) => a + b,
                },
              } as TBaseServices & { math: { add: (a: number, b: number) => number } };
            },
          });
        };
      };

      const definition = defineFragment<MyConfig>("type-preserve")
        .withDependencies(({ config }) => ({ computed: config.value * 2 }) as MyDeps)
        .providesService("calculator", ({ deps, defineService }) =>
          defineService({
            getComputed: () => deps.computed,
          }),
        )
        .usesService<"logger", { log: (msg: string) => void }>("logger")
        .extend(addMath())
        .build();

      // Config type is preserved
      expect(definition.dependencies).toBeDefined();
      const deps = definition.dependencies!({ config: { value: 10 }, options: {} });
      expect(deps.computed).toBe(20);

      // Named services are preserved
      expect(definition.namedServices).toBeDefined();
      const calculator = definition.namedServices!.calculator({
        config: { value: 10 },
        options: {},
        deps: { computed: 20 },
        serviceDeps: { logger: { log: () => {} } },
        privateServices: {},
        defineService: (svc) => svc,
      });
      expect(calculator.getComputed()).toBe(20);

      // Service dependencies are preserved
      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies!.logger).toEqual({ name: "logger", required: true });

      // Extended base service is present
      const services = definition.baseServices!({
        config: { value: 10 },
        options: {},
        deps: { computed: 20 },
        serviceDeps: { logger: { log: () => {} } },
        privateServices: {},
        defineService: (svc) => svc,
      });
      expect(services.math.add(5, 3)).toBe(8);
    });

    it("should allow extending to add request storage configuration", () => {
      // This test shows a practical extend() pattern: adding storage after deps are set
      const withRequestId = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ) => {
          // Simple approach: use the builder's own methods which handle types correctly
          return builder.withRequestStorage(() => ({
            requestId: Math.random().toString(36),
            timestamp: Date.now(),
          }));
        };
      };

      const definition = defineFragment("request-extend")
        .withDependencies(() => ({ value: 42 }))
        .extend(withRequestId())
        .build();

      expect(definition.createRequestStorage).toBeDefined();
      const storage = definition.createRequestStorage!({
        config: {},
        options: {},
        deps: { value: 42 },
      });
      expect(storage).toHaveProperty("requestId");
      expect(storage).toHaveProperty("timestamp");
      expect(typeof storage.requestId).toBe("string");
      expect(typeof storage.timestamp).toBe("number");
    });
  });

  describe("edge cases", () => {
    it("should handle extend on minimal fragment definition", () => {
      const addSimple = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices & { simple: string },
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          const currentDef = builder.build();
          const currentBaseServices = currentDef.baseServices;

          return new FragmentDefinitionBuilder(builder.name, {
            ...currentDef,
            baseServices: (context) => {
              const existing = currentBaseServices
                ? currentBaseServices(context)
                : ({} as TBaseServices);
              return {
                ...existing,
                simple: "value",
              } as TBaseServices & { simple: string };
            },
          });
        };
      };

      // Minimal fragment - just a name, then extend
      const definition = defineFragment("minimal").extend(addSimple()).build();

      expect(definition.name).toBe("minimal");
      expect(definition.baseServices).toBeDefined();

      const services = definition.baseServices!({
        config: {},
        options: {},
        deps: {},
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.simple).toBe("value");
    });

    it("should allow extend with identity transformation", () => {
      const identity = () => {
        return <
          TConfig,
          TOptions extends FragnoPublicConfig,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext extends RequestThisContext,
          THandlerThisContext extends RequestThisContext,
          TRequestStorage,
        >(
          builder: FragmentDefinitionBuilder<
            TConfig,
            TOptions,
            TDeps,
            TBaseServices,
            TServices,
            TServiceDeps,
            TPrivateServices,
            TServiceThisContext,
            THandlerThisContext,
            TRequestStorage
          >,
        ): FragmentDefinitionBuilder<
          TConfig,
          TOptions,
          TDeps,
          TBaseServices,
          TServices,
          TServiceDeps,
          TPrivateServices,
          TServiceThisContext,
          THandlerThisContext,
          TRequestStorage
        > => {
          // Just return the builder unchanged
          return builder;
        };
      };

      const definition = defineFragment("identity")
        .withDependencies(() => ({ x: 1 }))
        .extend(identity())
        .build();

      expect(definition.name).toBe("identity");
      expect(definition.dependencies).toBeDefined();

      const deps = definition.dependencies!({ config: {}, options: {} });
      expect(deps.x).toBe(1);
    });
  });
});
