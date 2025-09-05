import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("createLibrary API object transformation", () => {
  const source = dedent`
    import { createLibrary } from "@fragno-dev/core";
    const api = {
      messages: messageService,
      users: userService
    };
    export const library = createLibrary(publicConfig, libraryConfig, api);
  `;

  test("ssr:true - keeps api object", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toBe(source);
  });

  test("ssr:false - replaces api with undefined", () => {
    const expected = dedent`
      import { createLibrary } from "@fragno-dev/core";
      export const library = createLibrary(publicConfig, libraryConfig, undefined);
    `;
    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(expected);
  });
});

describe("createLibrary with inline api object", () => {
  const source = dedent`
    import { createLibrary } from "@fragno-dev/core"

    export function createMyLibrary(config) {
      return createLibrary(config, libConfig, {
        service1: myService1,
        service2: myService2
      });
    }
  `;

  test("ssr:false - replaces inline api with undefined", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
  });
});

describe("createLibrary with aliased import", () => {
  const source = dedent`
    import { createLibrary as makeLibrary } from "@fragno-dev/core"

    const myApi = { data: dataService };
    const lib = makeLibrary(pubConfig, libConfig, myApi);
  `;

  test("ssr:false - replaces api with undefined", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("makeLibrary(pubConfig, libConfig, undefined)");
  });
});

describe("createLibrary with only two arguments", () => {
  const source = dedent`
    import { createLibrary } from "@fragno-dev/core"

    export const lib = createLibrary(config, libraryConfig);
  `;

  test("ssr:false - does not modify when no api argument", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libraryConfig)");
    expect(result.code).not.toContain("undefined");
  });
});

describe("removes dead code after transform", () => {
  const source = dedent`
    import { createLibrary } from "@fragno-dev/core"
    import { createFileSync } from "fs";
    const api = { 
      createFile: () => {
        createFileSync("test.txt");
      }
    };
    export const lib = createLibrary(config, libConfig, api);
  `;

  test("ssr:false - removes dead code", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createFileSync");
  });
});

describe("non-fragno createLibrary - should not transform", () => {
  const source = dedent`
    import { createLibrary } from "other-package"

    const api = { service: myService };
    const lib = createLibrary(config, libConfig, api);
  `;

  test("ssr:false - does not transform non-fragno createLibrary", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, api)");
  });
});

describe("edge cases and potential breaking scenarios", () => {
  test("multiple createLibrary calls in same file", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const api1 = { service1: s1 };
      const api2 = { service2: s2 };
      
      export const lib1 = createLibrary(config1, libConfig1, api1);
      export const lib2 = createLibrary(config2, libConfig2, api2);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config1, libConfig1, undefined)");
    expect(result.code).toContain("createLibrary(config2, libConfig2, undefined)");
    expect(result.code).not.toContain("api1");
    expect(result.code).not.toContain("api2");
  });

  test("createLibrary with spread operator in api object", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const baseApi = { base: baseService };
      const api = { ...baseApi, extra: extraService };
      
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("baseApi");
    expect(result.code).not.toContain("extraService");
  });

  test("createLibrary with computed property names", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const key = "dynamicService";
      const api = { [key]: service, static: staticService };
      
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("dynamicService");
    expect(result.code).not.toContain("staticService");
  });

  test("createLibrary with method shorthand", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const api = { 
        getData() { return data; },
        processData: function() { return processed; }
      };
      
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("getData");
    expect(result.code).not.toContain("processData");
  });

  test("createLibrary with nested object expressions", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const lib = createLibrary(config, libConfig, {
        nested: {
          deep: {
            service: deepService
          }
        }
      });
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("deepService");
  });

  test("createLibrary with variable reference as argument", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const apiRef = someApiObject;
      export const lib = createLibrary(config, libConfig, apiRef);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("someApiObject");
  });

  test("createLibrary with function call as api argument", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      function buildApi() {
        return { service: myService };
      }
      
      export const lib = createLibrary(config, libConfig, buildApi());
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("buildApi");
    expect(result.code).not.toContain("myService");
  });

  test("createLibrary with more than 3 arguments", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const api = { service: myService };
      export const lib = createLibrary(config, libConfig, api, extraArg);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined, extraArg)");
  });

  test("createLibrary with TypeScript type annotations", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      interface ApiType {
        service: () => string;
      }
      
      const api: ApiType = { service: () => "test" };
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain('service: () => "test"');
  });

  test("createLibrary inside conditional blocks", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      const api = { service: myService };
      
      let _lib;
      if (condition) {
        _lib = createLibrary(config, libConfig, api);
      }

      export const lib = _lib;
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("myService");
  });

  test("createLibrary with comments and whitespace", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      // API configuration
      const api = { 
        // Main service
        service: myService,
        /* Another service */
        helper: helperService
      };
      
      export const lib = createLibrary(
        config, 
        libConfig, 
        api // API object
      );
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).not.toContain("myService");
    expect(result.code).not.toContain("helperService");
  });

  test("malformed code - missing import", () => {
    const source = dedent`
      const api = { service: myService };
      export const lib = createLibrary(config, libConfig, api);
    `;

    const result = transform(source, "", { ssr: false });
    // Should not transform since createLibrary is not imported from fragno
    expect(result.code).toContain("createLibrary(config, libConfig, api)");
  });

  test("malformed code - missing arguments", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      export const lib = createLibrary();
    `;

    const result = transform(source, "", { ssr: false });
    // Should not crash, just leave as-is since no 3rd argument
    expect(result.code).toContain("createLibrary()");
  });

  test("createLibrary with destructured import", () => {
    const source = dedent`
      import { createLibrary, otherFunction } from "@fragno-dev/core";
      
      const api = { service: myService };
      export const lib = createLibrary(config, libConfig, api);
      export const other = otherFunction();
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)");
    expect(result.code).toContain("otherFunction()");
    expect(result.code).not.toContain("myService");
  });

  test("createLibrary with renamed binding in scope", () => {
    const source = dedent`
      import { createLibrary } from "@fragno-dev/core";
      
      function myFunction() {
        const createLibrary = someOtherFunction;
        const api = { service: myService };
        return createLibrary(config, libConfig, api);
      }
      
      const api2 = { service: myService2 };
      export const lib = createLibrary(config, libConfig, api2);
    `;

    const result = transform(source, "", { ssr: false });
    // Should only transform the outer createLibrary call
    expect(result.code).toContain("return createLibrary(config, libConfig, api)"); // unchanged
    expect(result.code).toContain("createLibrary(config, libConfig, undefined)"); // transformed
    expect(result.code).not.toContain("myService2");
  });
});
