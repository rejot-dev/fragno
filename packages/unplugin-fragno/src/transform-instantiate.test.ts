import { parse } from "@babel/parser";
import { generate } from "@babel/generator";
import { describe, expect, test } from "vitest";
import { transformInstantiate } from "./transform-instantiate";
import dedent from "dedent";

function transform(source: string, _id: string, options: { ssr: boolean }) {
  const ast = parse(source, { sourceType: "module", plugins: [["typescript", {}]] });
  transformInstantiate(ast, options);
  return generate(ast);
}

describe("transformInstantiate", () => {
  describe("SSR builds", () => {
    test("does not transform in SSR builds", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiate(definition)
            .withConfig({ key: "value" })
            .withRoutes([route1])
            .build();
        }
      `;

      const result = transform(source, "", { ssr: true });
      expect(result.code).toContain("instantiate(definition)");
      expect(result.code).toContain("withConfig");
      expect(result.code).toContain("build()");
    });
  });

  describe("Browser builds - instantiate", () => {
    test("replaces simple instantiate chain with empty object", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiate(definition).build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createFragment() {
          return {};
        }"
      `);
    });

    test("replaces instantiate chain with withConfig", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiate(definition)
            .withConfig({ key: "value" })
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createFragment() {
          return {};
        }"
      `);
    });

    test("replaces instantiate chain with withRoutes", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiate(definition)
            .withRoutes([route1, route2])
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createFragment() {
          return {};
        }"
      `);
    });

    test("replaces full instantiate chain with all methods", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createExampleFragment(
          serverConfig = {},
          options = {},
        ) {
          const config = {
            initialData: serverConfig.initialData ?? "Hello World!",
          };

          return instantiate(exampleFragmentDefinition)
            .withConfig(config)
            .withRoutes([exampleRoutesFactory])
            .withOptions(options)
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createExampleFragment(serverConfig = {}, options = {}) {
          const config = {
            initialData: serverConfig.initialData ?? "Hello World!"
          };
          return {};
        }"
      `);
    });

    test("replaces multiple instantiate calls in same file", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment1() {
          return instantiate(def1).withConfig({}).build();
        }
        
        export function createFragment2() {
          return instantiate(def2).withRoutes([]).build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createFragment1() {
          return {};
        }
        export function createFragment2() {
          return {};
        }"
      `);
    });

    test("replaces instantiate in variable assignment", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        const fragment = instantiate(definition)
          .withConfig({ key: "value" })
          .withRoutes([route1])
          .build();
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        const fragment = {};"
      `);
    });
  });

  describe("Browser builds - instantiateFragment", () => {
    test("replaces instantiateFragment chain with empty object", () => {
      const source = dedent`
        import { instantiateFragment } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiateFragment(fragmentBuilder)
            .withConfig({ key: "value" })
            .withRoutes([route1])
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiateFragment } from "@fragno-dev/core";
        export function createFragment() {
          return {};
        }"
      `);
    });

    test("replaces multiple different instantiation functions", () => {
      const source = dedent`
        import { instantiate, instantiateFragment } from "@fragno-dev/core";
        
        export function createNew() {
          return instantiate(def).build();
        }
        
        export function createOld() {
          return instantiateFragment(builder).build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate, instantiateFragment } from "@fragno-dev/core";
        export function createNew() {
          return {};
        }
        export function createOld() {
          return {};
        }"
      `);
    });
  });

  describe("Edge cases", () => {
    test("does not transform instantiate from other packages", () => {
      const source = dedent`
        import { instantiate } from "some-other-library";
        
        export function createFragment() {
          return instantiate(definition)
            .withConfig({ key: "value" })
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("instantiate(definition)");
      expect(result.code).toContain("withConfig");
      expect(result.code).not.toContain("return {};");
    });

    test("does not transform locally defined instantiate function", () => {
      const source = dedent`
        function instantiate(def) {
          return { withConfig: () => ({ build: () => def }) };
        }
        
        export function createFragment() {
          return instantiate(definition).withConfig({}).build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain("instantiate(definition)");
      expect(result.code).not.toContain("return {};");
    });

    test("handles instantiate imported from different Fragno package paths", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
        
        export function createFragment() {
          return instantiate(definition).build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
        export function createFragment() {
          return {};
        }"
      `);
    });

    test("preserves other code around instantiation", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment(config) {
          console.log("Creating fragment");
          const result = instantiate(definition).withConfig(config).build();
          console.log("Fragment created");
          return result;
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toContain('console.log("Creating fragment")');
      expect(result.code).toContain('console.log("Fragment created")');
      expect(result.code).toContain("const result = {};");
    });

    test("handles instantiate without .build() call", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function getBuilder() {
          return instantiate(definition).withConfig({ key: "value" });
        }
      `;

      const result = transform(source, "", { ssr: false });
      // Should still replace the entire chain
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function getBuilder() {
          return {};
        }"
      `);
    });
  });

  describe("Complex scenarios", () => {
    test("handles instantiate with complex config construction", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment(serverConfig = {}) {
          const config = {
            apiKey: serverConfig.apiKey ?? process.env.API_KEY,
            endpoint: serverConfig.endpoint ?? "https://api.example.com",
            options: {
              retry: true,
              timeout: 5000,
            },
          };
          
          const routes = [route1, route2];
          
          return instantiate(definition)
            .withConfig(config)
            .withRoutes(routes)
            .withOptions({ mountRoute: "/api" })
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      // Config construction should be preserved, only instantiate chain replaced
      expect(result.code).toContain("const config = {");
      expect(result.code).toContain("const routes = [route1, route2]");
      expect(result.code).toContain("return {};");
      expect(result.code).not.toContain("instantiate(definition)");
    });

    test("handles nested function calls in instantiate arguments", () => {
      const source = dedent`
        import { instantiate } from "@fragno-dev/core";
        
        export function createFragment() {
          return instantiate(getDefinition())
            .withConfig(getConfig())
            .withRoutes(getRoutes())
            .build();
        }
      `;

      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { instantiate } from "@fragno-dev/core";
        export function createFragment() {
          return {};
        }"
      `);
    });
  });
});
