/**
 * Modified from: pcattori/vite-env-only
 * Original source: https://github.com/pcattori/vite-env-only/blob/45a39e7fb52e9fae4300e95aa51ed0880374f507/src/transform.test.ts
 * License: MIT
 * Date obtained: September 4 2025
 * Copyright (c) 2024 Pedro Cattori
 */

import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { name as pkgName } from "../package.json";

import { transform } from "./transform";

const macrosSpecifier = `${pkgName}/macros`;
const macros = ["serverOnly$", "clientOnly$"] as const;

describe("serverOnly$", () => {
  const source = dedent`
    import { serverOnly$ } from "${macrosSpecifier}"

    export const message = serverOnly$("server only")
  `;

  test("ssr:true", () => {
    const expected = dedent`
      export const message = "server only";
    `;
    expect(transform(source, "", { ssr: true }).code).toBe(expected);
  });

  test("ssr:false", () => {
    const expected = dedent`
      export const message = undefined;
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(expected);
  });
});

describe("clientOnly$", () => {
  const source = dedent`
    import { clientOnly$ } from "${macrosSpecifier}"

    export const message = clientOnly$("client only")
  `;

  test("ssr:true", () => {
    const expected = dedent`
      export const message = undefined;
    `;
    expect(transform(source, "", { ssr: true }).code).toBe(expected);
  });

  test("ssr:false", () => {
    const expected = dedent`
      export const message = "client only";
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(expected);
  });
});

describe("complex", () => {
  const source = dedent`
    import { serverOnly$, clientOnly$ } from "${macrosSpecifier}"
    import { a } from "server-only"
    import { b } from "client-only"

    export const c = serverOnly$("server only")
    const d = serverOnly$(a)
    console.log(d)

    export const e = clientOnly$("client only")
    const f = clientOnly$(b)
    console.log(f)
  `;

  test("ssr:true", () => {
    const expected = dedent`
      import { a } from "server-only";
      export const c = "server only";
      const d = a;
      console.log(d);
      export const e = undefined;
      const f = undefined;
      console.log(f);
    `;
    expect(transform(source, "", { ssr: true }).code).toBe(expected);
  });
  test("ssr:false", () => {
    const expected = dedent`
      import { b } from "client-only";
      export const c = undefined;
      const d = undefined;
      console.log(d);
      export const e = "client only";
      const f = b;
      console.log(f);
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(expected);
  });
});

for (const macro of macros) {
  test(`exactly one argument / ${macro}`, () => {
    const source = dedent`
      import { ${macro} } from "${macrosSpecifier}"

      export const message = ${macro}()
    `;
    for (const ssr of [false, true]) {
      expect(() => transform(source, "", { ssr })).toThrow(
        `'${macro}' must take exactly one argument`,
      );
    }
  });
}

for (const macro of macros) {
  test(`alias / ${macro}`, () => {
    const source = dedent`
      import { ${macro} as x } from "${macrosSpecifier}"

      export const message = x("hello")
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(
      macro === "serverOnly$"
        ? `export const message = undefined;`
        : `export const message = "hello";`,
    );
    expect(transform(source, "", { ssr: true }).code).toBe(
      macro === "serverOnly$"
        ? `export const message = "hello";`
        : `export const message = undefined;`,
    );
  });
}

for (const macro of macros) {
  test(`no dynamic / ${macro}`, () => {
    const source = dedent`
      import { ${macro} as x } from "${macrosSpecifier}"

      const z = x

      export const message = z("server only")
    `;
    for (const ssr of [false, true]) {
      expect(() => transform(source, "", { ssr })).toThrow(
        "'x' macro cannot be manipulated at runtime as it must be statically analysable",
      );
    }
  });
}

test("no namespace import", () => {
  for (const macro of macros) {
    const source = dedent`
      import * as envOnly from "${macrosSpecifier}"

      export const message = envOnly.${macro}("server only")
    `;
    for (const ssr of [false, true]) {
      expect(() => transform(source, "", { ssr })).toThrow(
        `Namespace import is not supported by '${macrosSpecifier}'`,
      );
    }
  }
});

test("only eliminate newly unreferenced identifiers", () => {
  for (const macro of macros) {
    const source = dedent`
      import { ${macro} } from "${macrosSpecifier}"
      import { dep } from "dep"

      const compute = () => dep() + 1
      export const a = ${macro}(compute())

      const _compute = () => 1
      const _b = _compute()
    `;
    const expected = dedent`
      export const a = undefined;
      const _compute = () => 1;
      const _b = _compute();
    `;
    expect(transform(source, "", { ssr: macro === "serverOnly$" ? false : true }).code).toBe(
      expected,
    );
  }
});

describe("macro edge cases and potential breaking scenarios", () => {
  test("multiple macro calls with same variable names", () => {
    const source = dedent`
      import { serverOnly$, clientOnly$ } from "${macrosSpecifier}"
      
      const data = "shared";
      export const server1 = serverOnly$(data);
      export const server2 = serverOnly$(data);
      export const client1 = clientOnly$(data);
      export const client2 = clientOnly$(data);
    `;

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toBe(dedent`
      const data = "shared";
      export const server1 = data;
      export const server2 = data;
      export const client1 = undefined;
      export const client2 = undefined;`);

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toBe(dedent`
      const data = "shared";
      export const server1 = undefined;
      export const server2 = undefined;
      export const client1 = data;
      export const client2 = data;`);
  });

  test("macro with complex expression arguments", () => {
    const source = dedent`
      import { serverOnly$ } from "${macrosSpecifier}"
      
      const obj = { prop: "value" };
      export const result = serverOnly$(obj.prop + " suffix");
    `;

    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain('result = obj.prop + " suffix"');

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toContain("result = undefined");
    expect(resultClient.code).not.toContain("obj.prop");
  });

  test("macro with function call arguments", () => {
    const source = dedent`
      import { clientOnly$ } from "${macrosSpecifier}"
      
      function getData() {
        return "client data";
      }
      
      export const data = clientOnly$(getData());
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("data = getData()");

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain("data = undefined");
    expect(resultSSR.code).not.toContain("getData");
  });

  test("macro with template literal arguments", () => {
    const source = dedent`
      import { serverOnly$ } from "${macrosSpecifier}"
      
      const name = "server";
      export const message = serverOnly$(\`Hello \${name}!\`);
    `;

    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("message = `Hello ${name}!`");

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toContain("message = undefined");
    expect(resultClient.code).not.toContain("name");
  });

  test("macro with object/array arguments", () => {
    const source = dedent`
      import { serverOnly$, clientOnly$ } from "${macrosSpecifier}"
      
      const serverConfig = { host: "localhost", port: 3000 };
      const clientRoutes = ["/home", "/about", "/contact"];
      
      export const config = serverOnly$(serverConfig);
      export const routes = clientOnly$(clientRoutes);
    `;

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain("config = serverConfig");
    expect(resultSSR.code).toContain("routes = undefined");
    expect(resultSSR.code).not.toContain("clientRoutes");

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toContain("config = undefined");
    expect(resultClient.code).toContain("routes = clientRoutes");
    expect(resultClient.code).not.toContain("serverConfig");
  });

  test("macro calls inside other function calls", () => {
    const source = dedent`
      import { serverOnly$ } from "${macrosSpecifier}"
      
      function processData(data) {
        return data.toUpperCase();
      }
      
      export const result = processData(serverOnly$("server data"));
    `;

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain('processData("server data")');

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toContain("processData(undefined)");
  });

  test("macro with conditional expressions", () => {
    const source = dedent`
      import { clientOnly$ } from "${macrosSpecifier}"
      
      const condition = true;
      export const value = clientOnly$(condition ? "client" : "fallback");
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain('value = condition ? "client" : "fallback"');

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain("value = undefined");
    expect(resultSSR.code).not.toContain("condition");
  });

  test("macro calls in destructuring assignments", () => {
    const source = dedent`
      import { serverOnly$, clientOnly$ } from "${macrosSpecifier}"
      
      const serverData = { a: 1, b: 2 };
      const clientData = { x: 10, y: 20 };
      
      const { a } = serverOnly$(serverData);
      const [x, y] = clientOnly$([clientData.x, clientData.y]);
    `;

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toBe(dedent`
      const serverData = {
        a: 1,
        b: 2
      };
      const {
        a
      } = serverData;
      const [x, y] = undefined;`);

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toBe(dedent`
      const clientData = {
        x: 10,
        y: 20
      };
      const {
        a
      } = undefined;
      const [x, y] = [clientData.x, clientData.y];`);
  });

  test("macro with recursive function calls", () => {
    const source = dedent`
      import { serverOnly$ } from "${macrosSpecifier}"
      
      function fibonacci(n) {
        if (n <= 1) return n;
        return fibonacci(n - 1) + fibonacci(n - 2);
      }
      
      export const result = serverOnly$(fibonacci(10));
    `;

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain("result = fibonacci(10)");

    const resultClient = transform(source, "", { ssr: false });
    expect(resultClient.code).toContain("result = undefined");
    expect(resultClient.code).not.toContain("fibonacci");
  });

  test("macro calls with side effects in arguments", () => {
    const source = dedent`
      import { clientOnly$ } from "${macrosSpecifier}"
      
      let counter = 0;
      function increment() {
        return ++counter;
      }
      
      export const value = clientOnly$(increment());
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("value = increment()");

    const resultSSR = transform(source, "", { ssr: true });
    expect(resultSSR.code).toContain("value = undefined");
    expect(resultSSR.code).not.toContain("increment");
    expect(resultSSR.code).not.toContain("counter");
  });
});

describe("typescript - serverOnly$", () => {
  const source = dedent`
  import { serverOnly$ } from "${macrosSpecifier}"

  export const message: string = serverOnly$("server only")
`;

  test("ssr:true", () => {
    const expected = dedent`
      export const message: string = "server only";
    `;

    expect(transform(source, "", { ssr: true }).code).toBe(expected);
  });

  test("ssr:false", () => {
    const expected = dedent`
      export const message: string = undefined;
    `;
    expect(transform(source, "", { ssr: false }).code).toBe(expected);
  });
});
