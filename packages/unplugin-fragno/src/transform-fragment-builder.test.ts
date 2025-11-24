import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("Fragment builder transformation", () => {
  describe("withDependencies", () => {
    test("ssr:true - keeps callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withDependencies(({ config }) => ({
            apiKey: config.key
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: true });
      expect(result.code).toContain("withDependencies");
      expect(result.code).toContain("apiKey");
      expect(result.code).toContain("config.key");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withDependencies(({
          config
        }) => ({
          apiKey: config.key
        })).build();"
      `);
    });

    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withDependencies(({ config }) => ({
            apiKey: config.key
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).not.toContain("apiKey");
      expect(result.code).not.toContain("config.key");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withDependencies(() => {}).build();"
      `);
    });
  });

  describe("providesBaseService", () => {
    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .providesBaseService(({ deps }) => ({
            getData: () => deps.data,
            setData: (value) => { deps.data = value; }
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).not.toContain("getData");
      expect(result.code).not.toContain("setData");
      expect(result.code).not.toContain("deps.data");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").providesBaseService(() => {}).build();"
      `);
    });
  });

  describe("providesService", () => {
    test("ssr:false - keeps service name but strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .providesService("myService", ({ deps }) => ({
            doSomething: () => deps.data
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain('providesService("myService", () => {})');
      expect(result.code).not.toContain("doSomething");
      expect(result.code).not.toContain("deps.data");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").providesService("myService", () => {}).build();"
      `);
    });

    test("ssr:false - handles multiple providesService calls", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .providesService("service1", () => ({ method1: () => "test1" }))
          .providesService("service2", () => ({ method2: () => "test2" }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain('providesService("service1", () => {})');
      expect(result.code).toContain('providesService("service2", () => {})');
      expect(result.code).not.toContain("method1");
      expect(result.code).not.toContain("method2");
      expect(result.code).not.toContain("test1");
      expect(result.code).not.toContain("test2");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").providesService("service1", () => {}).providesService("service2", () => {}).build();"
      `);
    });
  });

  describe("withRequestStorage", () => {
    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withRequestStorage(({ config, deps }) => ({
            counter: 0,
            userId: deps.currentUserId
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withRequestStorage(() => {})");
      expect(result.code).not.toContain("counter");
      expect(result.code).not.toContain("userId");
      expect(result.code).not.toContain("currentUserId");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withRequestStorage(() => {}).build();"
      `);
    });
  });

  describe("withExternalRequestStorage", () => {
    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withExternalRequestStorage(({ options }) =>
            options.databaseAdapter.contextStorage
          )
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withExternalRequestStorage(() => {})");
      expect(result.code).not.toContain("databaseAdapter");
      expect(result.code).not.toContain("contextStorage");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withExternalRequestStorage(() => {}).build();"
      `);
    });
  });

  describe("withRequestThisContext", () => {
    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withRequestThisContext(({ storage }) => ({
            get counter() { return storage.getStore()?.counter ?? 0; },
            getUser() { return storage.getStore()?.user; }
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withRequestThisContext(() => {})");
      expect(result.code).not.toContain("counter");
      expect(result.code).not.toContain("getUser");
      expect(result.code).not.toContain("storage.getStore");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withRequestThisContext(() => {}).build();"
      `);
    });
  });

  describe("extend", () => {
    test("ssr:false - strips callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { withDatabase } from "@fragno-dev/db";
        
        const fragment = defineFragment("test")
          .extend(withDatabase(schema))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("extend(() => {})");
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).not.toContain("schema");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").extend(() => {}).build();"
      `);
    });

    test("ssr:true - keeps callback", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { withDatabase } from "@fragno-dev/db";
        
        const fragment = defineFragment("test")
          .extend(withDatabase(schema))
          .build();
      `;

      const result = transform(source, "", { ssr: true });
      expect(result.code).toContain("extend(withDatabase(schema))");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { withDatabase } from "@fragno-dev/db";
        const fragment = defineFragment("test").extend(withDatabase(schema)).build();"
      `);
    });
  });

  describe("complex builder chains", () => {
    test("ssr:false - strips all callbacks in chain", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withDependencies(({ config }) => ({
            data: config.initialData
          }))
          .providesBaseService(({ deps }) => ({
            getData: () => deps.data
          }))
          .providesService("auth", ({ deps }) => ({
            login: (user) => performLogin(user, deps.data)
          }))
          .withRequestStorage(({ deps }) => ({
            userId: deps.currentUserId
          }))
          .withRequestThisContext(({ storage }) => ({
            getUserId: () => storage.getStore()?.userId
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).toContain('providesService("auth", () => {})');
      expect(result.code).toContain("withRequestStorage(() => {})");
      expect(result.code).toContain("withRequestThisContext(() => {})");
      expect(result.code).not.toContain("initialData");
      expect(result.code).not.toContain("getData");
      expect(result.code).not.toContain("login");
      expect(result.code).not.toContain("performLogin");
      expect(result.code).not.toContain("getUserId");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withDependencies(() => {}).providesBaseService(() => {}).providesService("auth", () => {}).withRequestStorage(() => {}).withRequestThisContext(() => {}).build();"
      `);
    });

    test("ssr:false - handles chain with extend", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { withDatabase } from "@fragno-dev/db";
        
        const fragment = defineFragment("test")
          .extend(withDatabase(mySchema))
          .withDependencies(({ config }) => ({ data: config.data }))
          .providesService("db", ({ deps }) => ({
            query: () => deps.orm.query()
          }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("extend(() => {})");
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain('providesService("db", () => {})');
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).not.toContain("mySchema");
      expect(result.code).not.toContain("query");
      expect(result.code).not.toContain("orm.query");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").extend(() => {}).withDependencies(() => {}).providesService("db", () => {}).build();"
      `);
    });
  });

  describe("import variations", () => {
    test("old API from @fragno-dev/core uses old transform", () => {
      // Note: Imports from root @fragno-dev/core use the OLD API (transformDefineLibrary)
      // The NEW builder API should only be imported from @fragno-dev/core/api/fragment-definition-builder
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core";
        
        const fragment = defineFragment("test")
          .withDependencies(() => ({ data: "test" }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      // OLD API replaces callback with () => {}
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).not.toContain("data");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core";
        const fragment = defineFragment("test").withDependencies(() => {}).build();"
      `);
    });

    test("works with aliased imports", () => {
      const source = dedent`
        import { defineFragment as createFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = createFragment("test")
          .withDependencies(() => ({ data: "test" }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).not.toContain("data");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment as createFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = createFragment("test").withDependencies(() => {}).build();"
      `);
    });
  });

  describe("edge cases", () => {
    test("does not transform non-fragno defineFragment", () => {
      const source = dedent`
        import { defineFragment } from "some-other-package";
        
        const fragment = defineFragment("test")
          .withDependencies(() => ({ data: "test" }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => ({");
      expect(result.code).toContain('data: "test"');
    });

    test("handles empty callbacks", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withDependencies(() => ({}))
          .providesBaseService(() => ({}))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withDependencies(() => {}).providesBaseService(() => {}).build();"
      `);
    });

    test("handles arrow functions with block statements", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .withDependencies(({ config }) => {
            const data = computeData(config);
            return { data };
          })
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).not.toContain("computeData");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").withDependencies(() => {}).build();"
      `);
    });

    test("handles async callbacks", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .providesBaseService(async ({ deps }) => {
            const data = await fetchData();
            return { getData: () => data };
          })
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).not.toContain("fetchData");
      expect(result.code).not.toContain("await");
    });
  });

  describe("usesService and usesOptionalService - should not transform", () => {
    test("usesService should remain unchanged", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .usesService("authService")
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain('usesService("authService")');
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").usesService("authService").build();"
      `);
    });

    test("usesOptionalService should remain unchanged", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment = defineFragment("test")
          .usesOptionalService("loggingService")
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain('usesOptionalService("loggingService")');
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment = defineFragment("test").usesOptionalService("loggingService").build();"
      `);
    });
  });

  describe("multiple fragments in same file", () => {
    test("transforms all fragments independently", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        
        const fragment1 = defineFragment("fragment1")
          .withDependencies(() => ({ data1: "test1" }))
          .build();
        
        const fragment2 = defineFragment("fragment2")
          .withDependencies(() => ({ data2: "test2" }))
          .providesService("myService", () => ({ method: () => "test" }))
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).not.toContain("data1");
      expect(result.code).not.toContain("data2");
      expect(result.code).not.toContain("method");
      expect(result.code).not.toContain("test1");
      expect(result.code).not.toContain("test2");
      const matches = result.code.match(/withDependencies\(\(\) => \{\}\)/g);
      expect(matches).toHaveLength(2);
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const fragment1 = defineFragment("fragment1").withDependencies(() => {}).build();
        const fragment2 = defineFragment("fragment2").withDependencies(() => {}).providesService("myService", () => {}).build();"
      `);
    });
  });

  describe("integration with defineRoute", () => {
    test("strips builder callbacks and route handlers with destructuring", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { defineRoutes } from "@fragno-dev/core/api/route";
        
        const fragment = defineFragment("test")
          .withDependencies(() => ({ data: "test" }))
          .providesBaseService(() => ({
            getData: () => "data"
          }))
          .build();
        
        const routes = defineRoutes(fragment).create(({ defineRoute }) => [
          defineRoute({
            method: "GET",
            path: "/test",
            handler: async () => {
              return json({ message: "hello" });
            }
          })
        ]);
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).not.toContain("getData");
      // Handler should now be transformed to noop
      expect(result.code).toContain("handler: () => {}");
      expect(result.code).not.toContain('message: "hello"');
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { defineRoutes } from "@fragno-dev/core/api/route";
        const fragment = defineFragment("test").withDependencies(() => {}).providesBaseService(() => {}).build();
        const routes = defineRoutes(fragment).create(({
          defineRoute
        }) => [defineRoute({
          method: "GET",
          path: "/test",
          handler: () => {}
        })]);"
      `);
    });

    test("strips builder callbacks and route handlers with member access", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { defineRoutes } from "@fragno-dev/core/api/route";
        
        const fragment = defineFragment("test")
          .withDependencies(() => ({ data: "test" }))
          .providesBaseService(() => ({
            getData: () => "data"
          }))
          .build();
        
        const routes = defineRoutes(fragment).create((context) => [
          context.defineRoute({
            method: "GET",
            path: "/test",
            handler: async () => {
              return json({ message: "hello" });
            }
          })
        ]);
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).not.toContain("getData");
      // Handler should now be transformed to noop
      expect(result.code).toContain("handler: () => {}");
      expect(result.code).not.toContain('message: "hello"');
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { defineRoutes } from "@fragno-dev/core/api/route";
        const fragment = defineFragment("test").withDependencies(() => {}).providesBaseService(() => {}).build();
        const routes = defineRoutes(fragment).create(context => [context.defineRoute({
          method: "GET",
          path: "/test",
          handler: () => {}
        })]);"
      `);
    });
  });

  describe("real-world example from example-fragment", () => {
    test("transforms complete example fragment", () => {
      const source = dedent`
        import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        import { readFile } from "node:fs/promises";
        import { platform } from "node:os";
        import { createHash } from "node:crypto";
        
        const getHashFromHostsFileData = async () => {
          const hostsPath = platform() === "win32" ? "C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts" : "/etc/hosts";
          try {
            const data = await readFile(hostsPath, { encoding: "utf8" });
            return createHash("sha256").update(data).digest("hex");
          } catch {
            return null;
          }
        };
        
        const exampleFragmentDefinition = defineFragment("example-fragment")
          .withDependencies(({ config }) => {
            return {
              serverSideData: { value: config.initialData ?? "Hello World!" },
            };
          })
          .providesBaseService(({ deps }) => {
            return {
              getData: () => deps.serverSideData.value,
              getHashFromHostsFileData,
            };
          })
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesBaseService(() => {})");
      expect(result.code).not.toContain("serverSideData");
      expect(result.code).not.toContain("getData");
      expect(result.code).not.toContain("getHashFromHostsFileData");
      expect(result.code).not.toContain("node:");
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
        const exampleFragmentDefinition = defineFragment("example-fragment").withDependencies(() => {}).providesBaseService(() => {}).build();"
      `);
    });
  });
});
