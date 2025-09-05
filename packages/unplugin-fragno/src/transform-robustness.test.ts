import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("transform robustness and error handling", () => {
  test("empty file", () => {
    const source = "";
    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe("");
  });

  test("file with only comments", () => {
    const source = dedent`
      // This is a comment
      /* 
       * Multi-line comment
       */
    `;
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("// This is a comment");
  });

  test("dead code elimination - only removes code that becomes unused after our transforms", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      import { addRoute } from "@fragno-dev/core/api";
    `;
    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(source);
  });

  test("syntax error handling - malformed JavaScript", () => {
    const source = "import { createLibrary from";

    // Should throw a parsing error
    expect(() => transform(source, "", { ssr: false })).toThrow();
  });

  test("mixed valid and invalid transforms", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      import { addRoute } from "@fragno-dev/core/api";
      
      // Valid createLibrary
      const api = { service: myService };
      export const lib = createLibrary(config, libConfig, api);
      
      // Invalid addRoute (non-object config)
      export const route = addRoute("invalid");
      
      // Valid addRoute  
      export const route2 = addRoute({
        method: "GET",
        path: "/test",
        handler: () => ({ data: "test" })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).toContain('addRoute("invalid")'); // unchanged
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("myService");
    expect(result.code).not.toContain('data: "test"');
  });

  test("very large file with many transforms", () => {
    const createLibraryCalls = Array.from(
      { length: 50 },
      (_, i) =>
        `const api${i} = { service${i}: service${i} };\nexport const lib${i} = createLibrary(config${i}, libConfig${i}, api${i});`,
    ).join("\n");

    const addRouteCalls = Array.from(
      { length: 50 },
      (_, i) =>
        `export const route${i} = addRoute({ method: "GET", path: "/test${i}", handler: () => ({ data: "test${i}" }) });`,
    ).join("\n");

    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      import { addRoute } from "@fragno-dev/core/api";
      
      ${createLibraryCalls}
      ${addRouteCalls}
    `;

    const result = transform(source, "", { ssr: false });

    // All createLibrary calls should be transformed
    const undefinedMatches = result.code.match(/createLibrary\([^,]+, [^,]+, undefined\)/g);
    expect(undefinedMatches).toHaveLength(50);

    // All addRoute handlers should be transformed
    const noopMatches = result.code.match(/handler: \(\) => \{\}/g);
    expect(noopMatches).toHaveLength(50);

    // No original service references should remain
    expect(result.code).not.toContain("service0");
    expect(result.code).not.toContain('data: "test0"');
  });

  test("unicode and special characters in code", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const api = { 
        "🚀service": rocketService,
        "特殊服务": specialService,
        "service-with-dashes": dashedService
      };
      
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("🚀service");
    expect(result.code).not.toContain("特殊服务");
    expect(result.code).not.toContain("service-with-dashes");
  });

  test("deeply nested scopes", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      function outer() {
        function inner() {
          function deepest() {
            const api = { service: deepService };
            return createLibrary(config, libConfig, api);
          }
          return deepest();
        }
        return inner();
      }
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("deepService");
  });

  test("class methods with transforms", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      import { addRoute } from "@fragno-dev/core/api";
      
      class ApiBuilder {
        buildLibrary() {
          const api = { service: this.service };
          return createLibrary(this.config, this.libConfig, api);
        }
        
        buildRoute() {
          return addRoute({
            method: "GET",
            path: "/class",
            handler: (ctx) => this.handleRequest(ctx)
          });
        }
      }
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(this.config, this.libConfig, undefined)");
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("this.service");
    expect(result.code).not.toContain("this.handleRequest");
  });

  test("arrow functions and function expressions", () => {
    const source = dedent`
      import { addRoute } from "@fragno-dev/core/api";
      
      const createRoute = () => addRoute({
        method: "GET",
        path: "/arrow",
        handler: function(ctx) {
          return { message: "arrow function route" };
        }
      });
      
      const route = (function() {
        return addRoute({
          method: "POST",
          path: "/iife",
          handler: (ctx) => ({ message: "iife route" })
        });
      })();
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("arrow function route");
    expect(result.code).not.toContain("iife route");
    const matches = result.code.match(/handler: \(\) => \{\}/g);
    expect(matches).toHaveLength(2);
  });

  test("template literals and complex expressions", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const serviceName = "myService";
      const api = {
        [\`dynamic_\${serviceName}\`]: dynamicService,
        computed: computeService(),
        conditional: condition ? service1 : service2
      };
      
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("dynamicService");
    expect(result.code).not.toContain("computeService");
    expect(result.code).not.toContain("service1");
    expect(result.code).not.toContain("service2");
  });
});
