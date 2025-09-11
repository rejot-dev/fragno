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
      /* This is a 
         multiline comment */
      // Another comment
    `;
    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(source);
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
    const source = "const x = {]};";
    // Should throw a parsing error
    expect(() => transform(source, "", { ssr: false })).toThrow();
  });

  test("mixed valid and invalid transforms", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      import { defineRoute } from "@fragno-dev/core/api";
      
      // Valid defineLibrary with withDependencies
      const lib = defineLibrary("test")
        .withDependencies((config) => ({ db: createDB(config) }))
        .withServices(() => ({ cache: new Map() }));
      
      // Invalid defineRoute (non-object config)
      export const route = defineRoute("invalid");
      
      // Valid defineRoute  
      export const route2 = defineRoute({
        method: "GET",
        path: "/test",
        handler: () => ({ data: "test" })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).toContain(".withServices(() => {})");
    expect(result.code).toContain('defineRoute("invalid")'); // unchanged
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("createDB");
    expect(result.code).not.toContain('data: "test"');
  });

  test("very large file with many transforms", () => {
    const defineLibraryCalls = Array.from(
      { length: 50 },
      (_, i) =>
        `export const lib${i} = defineLibrary("lib${i}").withDependencies((config) => ({ service${i}: service${i} }));`,
    ).join("\n");

    const defineRouteCalls = Array.from(
      { length: 50 },
      (_, i) =>
        `export const route${i} = defineRoute({ method: "GET", path: "/test${i}", handler: () => ({ data: "test${i}" }) });`,
    ).join("\n");

    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      import { defineRoute } from "@fragno-dev/core/api";
      
      ${defineLibraryCalls}
      ${defineRouteCalls}
    `;

    const result = transform(source, "", { ssr: false });

    // All defineLibrary withDependencies calls should be transformed
    const withDepsMatches = result.code.match(/\.withDependencies\(\(\) => \{\}\)/g);
    expect(withDepsMatches).toHaveLength(50);

    // All defineRoute handlers should be transformed
    const noopMatches = result.code.match(/handler: \(\) => \{\}/g);
    expect(noopMatches).toHaveLength(50);

    // No original service references should remain
    expect(result.code).not.toContain("service0");
    expect(result.code).not.toContain('data: "test0"');
  });

  test("unicode and special characters in code", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      
      export const lib = defineLibrary("my-lib")
        .withDependencies((config) => ({ 
          "🚀service": rocketService,
          "特殊服务": specialService,
          "service-with-dashes": dashedService
        }));
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).not.toContain("🚀service");
    expect(result.code).not.toContain("特殊服务");
    expect(result.code).not.toContain("service-with-dashes");
    expect(result.code).not.toContain("rocketService");
    expect(result.code).not.toContain("specialService");
    expect(result.code).not.toContain("dashedService");
  });

  test("deeply nested scopes", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      
      function outer() {
        function inner() {
          function deepest() {
            return defineLibrary("nested")
              .withDependencies((config) => ({ service: deepService }));
          }
          return deepest();
        }
        return inner();
      }
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).not.toContain("deepService");
  });

  test("class methods with transforms", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      import { defineRoute } from "@fragno-dev/core/api";
      
      class ApiBuilder {
        buildLibrary() {
          return defineLibrary("class-lib")
            .withDependencies((config) => ({ service: this.service }));
        }
        
        buildRoute() {
          return defineRoute({
            method: "GET",
            path: "/class",
            handler: () => ({ classData: this.getData() })
          });
        }
      }
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("this.service");
    expect(result.code).not.toContain("this.getData()");
  });

  test("arrow functions and function expressions", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      import { defineRoute } from "@fragno-dev/core/api";
      
      const makeLib = () => {
        return defineLibrary("arrow-lib")
          .withServices(() => ({ service }));
      };
      
      const makeRoute = function() {
        return defineRoute({
          method: "POST",
          path: "/arrow",
          handler: function(ctx) {
            return { data: "arrow" };
          }
        });
      };
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withServices(() => {})");
    // The handler becomes an arrow function, not a function expression
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("service");
    expect(result.code).not.toContain('data: "arrow"');
  });

  test("template literals and complex expressions", () => {
    const source = dedent`
      import { defineLibrary } from "@fragno-dev/core";
      import { defineRoute } from "@fragno-dev/core/api";
      
      export const lib = defineLibrary("template-lib")
        .withDependencies((config) => ({
          [\`service_\${process.env.NODE_ENV}\`]: envService,
          [Symbol.for("special")]: symbolService
        }));
      
      export const route = defineRoute({
        method: "GET",
        path: \`/api/\${version}/resource\`,
        handler: () => ({
          env: process.env.NODE_ENV,
          data: \`Result: \${computeResult()}\`
        })
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).toContain("handler: () => {}");
    expect(result.code).not.toContain("envService");
    expect(result.code).not.toContain("symbolService");
    expect(result.code).not.toContain("process.env.NODE_ENV");
    expect(result.code).not.toContain("computeResult");
  });
});
