import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineRoute handler transformation", () => {
  const source = dedent`
    import { defineRoute } from "@fragno-dev/core/api"

    export const route = defineRoute({
      method: "GET",
      path: "/test",
      handler: async (ctx, { json }) => {
        return json({ message: "hello" });
      }
    })
  `;

  test("ssr:true - keeps handler", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toBe(dedent`
      import { defineRoute } from "@fragno-dev/core/api";
      export const route = defineRoute({
        method: "GET",
        path: "/test",
        handler: async (ctx, {
          json
        }) => {
          return json({
            message: "hello"
          });
        }
      });`);
  });

  test("ssr:false - replaces handler with noop", () => {
    const expected = dedent`
      import { defineRoute } from "@fragno-dev/core/api";
      export const route = defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      });
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(expected);
  });
});

describe("defineRoute from @fragno-dev/core", () => {
  const source = dedent`
    import { defineRoute } from "@fragno-dev/core"

    const myRoute = defineRoute({
      method: "POST",
      path: "/api/data",
      handler: async function(ctx, helpers) {
        const data = await fetchData();
        return helpers.json(data);
      }
    })
  `;

  test("ssr:false - replaces handler with noop", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("fetchData");
  });
});

describe("defineRoute with aliased import", () => {
  const source = dedent`
    import { defineRoute as createRoute } from "@fragno-dev/core/api"

    export const route = createRoute({
      method: "PUT",
      path: "/update",
      handler: (ctx) => ctx.json({ updated: true })
    })
  `;

  test("ssr:false - replaces handler with noop", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("updated: true");
  });
});

describe("removes dead code after transform", () => {
  const source = dedent`
    import { defineRoute } from "@fragno-dev/core"
    import { createFileSync } from "fs";
    const route = defineRoute({
      method: "GET",
      path: "/test",
      handler: () => {
        createFileSync("test.txt");
      }
    })
  `;

  test("ssr:false - removes dead code", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createFileSync");
  });
});

describe("non-fragno defineRoute - should not transform", () => {
  const source = dedent`
    import { defineRoute } from "some-other-package"

    export const route = defineRoute({
      method: "GET",
      path: "/test",
      handler: async () => ({ data: "test" })
    })
  `;

  test("ssr:false - does not transform non-fragno defineRoute", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain('data: "test"');
  });
});

describe("addRoute backward compatibility", () => {
  test("addRoute from @fragno-dev/core/api still works", () => {
    const source = dedent`
      import { addRoute } from "@fragno-dev/core/api"

      export const route = addRoute({
        method: "GET",
        path: "/test",
        handler: async (ctx, { json }) => {
          return json({ message: "hello" });
        }
      })
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(dedent`
      import { addRoute } from "@fragno-dev/core/api";
      export const route = addRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      });`);
  });

  test("addRoute from @fragno-dev/core still works", () => {
    const source = dedent`
      import { addRoute } from "@fragno-dev/core"

      const myRoute = addRoute({
        method: "POST",
        path: "/api/data",
        handler: async function(ctx, helpers) {
          const data = await fetchData();
          return helpers.json(data);
        }
      })
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("fetchData");
  });

  test("addRoute with aliased import still works", () => {
    const source = dedent`
      import { addRoute as createRoute } from "@fragno-dev/core/api"

      export const route = createRoute({
        method: "PUT",
        path: "/update",
        handler: (ctx) => ctx.json({ updated: true })
      })
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("updated: true");
  });
});

describe("defineRoute edge cases and potential breaking scenarios", () => {
  test("multiple defineRoute calls in same file", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route1 = defineRoute({
        method: "GET",
        path: "/test1",
        handler: async (ctx) => ({ data: "test1" })
      });

      export const route2 = defineRoute({
        method: "POST", 
        path: "/test2",
        handler: (ctx, { json }) => json({ data: "test2" })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('data: "test1"');
    expect(result.code).not.toContain('data: "test2"');
    // Should have two noop handlers
    const matches = result.code.match(/handler: \(\) => \{\}/g);
    expect(matches).toHaveLength(2);
  });

  test("defineRoute with method property as object method", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "GET",
        path: "/test",
        handler(ctx, helpers) {
          const data = processData();
          return helpers.json(data);
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler() {}");
    expect(result.code).not.toContain("processData");
  });

  test("defineRoute with complex handler parameters", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "POST",
        path: "/complex",
        handler: async (
          ctx: RequestContext,
          { json, status }: ResponseHelpers,
          extraParam?: string
        ) => {
          const result = await complexOperation(ctx, extraParam);
          return json(result, status(200));
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("complexOperation");
    expect(result.code).not.toContain("RequestContext");
    expect(result.code).not.toContain("ResponseHelpers");
  });

  test("defineRoute with destructured parameters in handler", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core"

      export const route = defineRoute({
        method: "GET",
        path: "/destruct",
        handler: ({ request, params }, { json }) => {
          const { id } = params;
          return json({ id, method: request.method });
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("request.method");
    expect(result.code).not.toContain("params");
  });

  test("defineRoute with arrow function handler with implicit return", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "GET",
        path: "/implicit",
        handler: (ctx, { json }) => json({ quick: "response" })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("quick");
  });

  test("defineRoute with no handler property", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api";
      export const route = defineRoute({
        method: "GET",
        path: "/no-handler"
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(source).toBe(result.code);
  });

  test("defineRoute with handler as variable reference", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      const myHandler = async (ctx, helpers) => {
        return helpers.json({ message: "hello" });
      };

      export const route = defineRoute({
        method: "GET",
        path: "/ref-handler",
        handler: myHandler
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("myHandler");
    expect(result.code).not.toContain('message: "hello"');
  });

  test("defineRoute with spread operator in config", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      const baseConfig = { method: "GET", path: "/base" };
      const handler = (ctx) => ({ success: true });

      export const route = defineRoute({
        ...baseConfig,
        handler
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("success: true");
  });

  test("defineRoute with computed property for handler", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      const handlerKey = "handler";
      const myHandler = (ctx) => ({ data: "computed" });

      export const route = defineRoute({
        method: "GET",
        path: "/computed",
        [handlerKey]: myHandler
      });
    `;

    const result = transform(source, "", { ssr: false });
    // This is tricky - the transform might not catch computed properties
    // We should test that it either transforms correctly or leaves it unchanged
    const hasNoop = result.code.includes("handler: () => {}");
    const hasOriginal = result.code.includes("myHandler");
    // One or the other should be true, but not both
    expect(hasNoop || hasOriginal).toBe(true);
    if (hasNoop) {
      expect(result.code).not.toContain("computed");
    }
  });

  test("defineRoute with nested route configurations", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      const routes = [
        defineRoute({
          method: "GET",
          path: "/nested1",
          handler: () => ({ data: "nested1" })
        }),
        defineRoute({
          method: "POST",
          path: "/nested2", 
          handler: async (ctx) => {
            const result = await processNested();
            return { result };
          }
        })
      ];
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(dedent`
      import { defineRoute } from "@fragno-dev/core/api";
      const routes = [defineRoute({
        method: "GET",
        path: "/nested1",
        handler: () => {}
      }), defineRoute({
        method: "POST",
        path: "/nested2",
        handler: () => {}
      })];`);
  });

  test("defineRoute with handler that throws", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "GET",
        path: "/error",
        handler: (ctx) => {
          throw new Error("Server error");
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("Server error");
  });

  test("malformed defineRoute - missing config object", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute();
    `;

    const result = transform(source, "", { ssr: false });
    // Should not crash, just leave as-is
    expect(result.code).toContain("defineRoute()");
  });

  test("malformed defineRoute - non-object config", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute("invalid-config");
    `;

    const result = transform(source, "", { ssr: false });
    // Should not crash, just leave as-is
    expect(result.code).toContain('defineRoute("invalid-config")');
  });

  test("defineRoute with mixed import sources", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"
      import { defineRoute as otherDefineRoute } from "other-package"

      export const route1 = defineRoute({
        method: "GET",
        path: "/fragno",
        handler: () => ({ fragno: true })
      });

      export const route2 = otherDefineRoute({
        method: "GET", 
        path: "/other",
        handler: () => ({ other: true })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(dedent`
      import { defineRoute } from "@fragno-dev/core/api";
      import { defineRoute as otherDefineRoute } from "other-package";
      export const route1 = defineRoute({
        method: "GET",
        path: "/fragno",
        handler: () => {}
      });
      export const route2 = otherDefineRoute({
        method: "GET",
        path: "/other",
        handler: () => ({
          other: true
        })
      });`);
  });

  test("defineRoute with handler containing async/await", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "POST",
        path: "/async",
        handler: async (ctx, { json }) => {
          const data = await fetchFromDatabase();
          const processed = await processData(data);
          return json({ processed });
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("fetchFromDatabase");
    expect(result.code).not.toContain("processData");
    expect(result.code).not.toContain("await");
  });

  test("defineRoute with handler containing try-catch", () => {
    const source = dedent`
      import { defineRoute } from "@fragno-dev/core/api"

      export const route = defineRoute({
        method: "GET",
        path: "/error-handling",
        handler: (ctx, { json }) => {
          try {
            const result = dangerousOperation();
            return json({ result });
          } catch (error) {
            return json({ error: error.message }, 500);
          }
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("dangerousOperation");
    expect(result.code).not.toContain("try");
    expect(result.code).not.toContain("catch");
  });

  test("defineRoute from callback parameter with destructuring", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api/route";
      
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
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('message: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api/route";
      const routes = defineRoutes(fragment).create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      })]);"
    `);
  });

  test("defineRoute from callback parameter with member access", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api/route";
      
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
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('message: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api/route";
      const routes = defineRoutes(fragment).create(context => [context.defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      })]);"
    `);
  });

  test("edge case: user-defined defineRoute function with destructuring should NOT be transformed", () => {
    // Non-Fragno callbacks should not be transformed
    const source = dedent`
      import { someOtherLibrary } from "some-library";
      
      const routes = someOtherLibrary.create(({ defineRoute }) => [
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
    // Should NOT be transformed because someOtherLibrary is not a Fragno route builder
    expect(result.code).toContain('message: "hello"');
    expect(result.code).not.toContain("handler: () => {}");
    expect(result.code).toMatchInlineSnapshot(`
      "import { someOtherLibrary } from "some-library";
      const routes = someOtherLibrary.create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/test",
        handler: async () => {
          return json({
            message: "hello"
          });
        }
      })]);"
    `);
  });

  test("edge case: user-defined defineRoute function with member access should NOT be transformed", () => {
    // Non-Fragno callbacks should not be transformed
    const source = dedent`
      import { someOtherLibrary } from "some-library";
      
      const routes = someOtherLibrary.create((context) => [
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
    // Should NOT be transformed because someOtherLibrary is not a Fragno route builder
    expect(result.code).toContain('message: "hello"');
    expect(result.code).not.toContain("handler: () => {}");
    expect(result.code).toMatchInlineSnapshot(`
      "import { someOtherLibrary } from "some-library";
      const routes = someOtherLibrary.create(context => [context.defineRoute({
        method: "GET",
        path: "/test",
        handler: async () => {
          return json({
            message: "hello"
          });
        }
      })]);"
    `);
  });

  test("edge case: locally defined defineRoute function is NOT transformed", () => {
    const source = dedent`
      function defineRoute(config) {
        return config;
      }
      
      const myRoute = defineRoute({
        method: "GET",
        path: "/test",
        handler: async () => {
          return { data: "hello" };
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    // This should NOT be transformed because defineRoute is not imported from Fragno
    expect(result.code).not.toContain("handler: () => {}");
    expect(result.code).toContain('data: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "function defineRoute(config) {
        return config;
      }
      const myRoute = defineRoute({
        method: "GET",
        path: "/test",
        handler: async () => {
          return {
            data: "hello"
          };
        }
      });"
    `);
  });
});

describe("defineRoutes with callback - Fragno API", () => {
  test("defineRoutes().create with destructured defineRoute IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api/route";
      
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
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('message: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api/route";
      const routes = defineRoutes(fragment).create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      })]);"
    `);
  });

  test("defineRoutes().create with member access defineRoute IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api/route";
      
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
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('message: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api/route";
      const routes = defineRoutes(fragment).create(context => [context.defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      })]);"
    `);
  });

  test("defineRoutes from @fragno-dev/core IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core";
      
      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "POST",
          path: "/api/data",
          handler: async (input) => {
            const result = await processData(input);
            return json(result);
          }
        })
      ]);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("processData");
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core";
      const routes = defineRoutes(definition).create(({
        defineRoute
      }) => [defineRoute({
        method: "POST",
        path: "/api/data",
        handler: () => {}
      })]);"
    `);
  });
});

describe("defineRoutes with callback - Fragno API", () => {
  test("defineRoutes().create with destructured defineRoute IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api";
      
      const routes = defineRoutes().create(({ defineRoute }) => [
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
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain('message: "hello"');
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api";
      const routes = defineRoutes().create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/test",
        handler: () => {}
      })]);"
    `);
  });

  test("defineRoutes().create with member access defineRoute IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core";
      
      const routes = defineRoutes(fragment).create((context) => [
        context.defineRoute({
          method: "POST",
          path: "/update",
          handler: async (input) => {
            const updated = await updateData(input);
            return json({ success: true, data: updated });
          }
        })
      ]);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("updateData");
    expect(result.code).not.toContain("success: true");
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core";
      const routes = defineRoutes(fragment).create(context => [context.defineRoute({
        method: "POST",
        path: "/update",
        handler: () => {}
      })]);"
    `);
  });

  test("defineRoutes with multiple routes IS transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api";
      
      const routes = defineRoutes().create(({ defineRoute, config }) => [
        defineRoute({
          method: "GET",
          path: "/route1",
          handler: async () => json({ data: "route1" })
        }),
        defineRoute({
          method: "POST",
          path: "/route2",
          handler: async () => json({ data: "route2" })
        })
      ]);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(dedent`
      import { defineRoutes } from "@fragno-dev/core/api";
      const routes = defineRoutes().create(({
        defineRoute,
        config
      }) => [defineRoute({
        method: "GET",
        path: "/route1",
        handler: () => {}
      }), defineRoute({
        method: "POST",
        path: "/route2",
        handler: () => {}
      })]);`);
  });
});

describe("mixed Fragno and non-Fragno callbacks", () => {
  test("only Fragno callbacks are transformed", () => {
    const source = dedent`
      import { defineRoutes } from "@fragno-dev/core/api/route";
      import { someOtherLibrary } from "some-library";
      
      const fragnoRoutes = defineRoutes(fragment).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/fragno",
          handler: async () => json({ fragno: true })
        })
      ]);
      
      const otherRoutes = someOtherLibrary.create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/other",
          handler: async () => json({ other: true })
        })
      ]);
    `;

    const result = transform(source, "", { ssr: false });

    expect(result.code).toMatchInlineSnapshot(`
      "import { defineRoutes } from "@fragno-dev/core/api/route";
      import { someOtherLibrary } from "some-library";
      const fragnoRoutes = defineRoutes(fragment).create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/fragno",
        handler: () => {}
      })]);
      const otherRoutes = someOtherLibrary.create(({
        defineRoute
      }) => [defineRoute({
        method: "GET",
        path: "/other",
        handler: async () => json({
          other: true
        })
      })]);"
    `);
  });
});
