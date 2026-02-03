import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineFragmentWithDatabase → defineFragment replacement", () => {
  describe("basic replacement", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineFragmentWithDatabase("mylib")
        .withDatabase(mySchema);
    `;

    test("ssr:false - replaces with defineFragment and adds import", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core";
        const lib = defineFragment("mylib");"
      `);
    });

    test("ssr:true - keeps original code", () => {
      const result = transform(source, "", { ssr: true });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragmentWithDatabase } from "@fragno-dev/db";
        import { mySchema } from "./schema";
        const lib = defineFragmentWithDatabase("mylib").withDatabase(mySchema);"
      `);
    });
  });

  describe("with aliased import", () => {
    const source = dedent`
      import { defineFragmentWithDatabase as defineDbFrag } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineDbFrag("mylib")
        .withDatabase(mySchema);
    `;

    test("ssr:false - handles aliased imports", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core";
        const lib = defineFragment("mylib");"
      `);
    });
  });

  describe("multiple calls in same file", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { schema1, schema2 } from "./schemas";
      
      const lib1 = defineFragmentWithDatabase("lib1")
        .withDatabase(schema1);
      
      const lib2 = defineFragmentWithDatabase("lib2")
        .withDatabase(schema2);
    `;

    test("ssr:false - transforms all calls", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core";
        const lib1 = defineFragment("lib1");
        const lib2 = defineFragment("lib2");"
      `);
    });
  });

  describe("with existing defineFragment import", () => {
    const source = dedent`
      import { defineFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib1 = defineFragment("lib1")
        .providesService(() => ({ svc: service1 }));
      
      const lib2 = defineFragmentWithDatabase("lib2")
        .withDatabase(mySchema);
    `;

    test("ssr:false - reuses existing defineFragment import", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragment } from "@fragno-dev/core";
        const lib1 = defineFragment("lib1").providesService(() => {});
        const lib2 = defineFragment("lib2");"
      `);
    });
  });
});

describe("FragnoPublicConfigWithDatabase → FragnoPublicConfig replacement", () => {
  describe("in function parameters", () => {
    const source = dedent`
      import { createFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
      
      export function createMyFragment(
        config: MyConfig,
        fragnoConfig: FragnoPublicConfigWithDatabase,
      ) {
        return createFragment(defineFragmentWithDatabase("mylib"), config, [], fragnoConfig);
      }
    `;

    test("ssr:false - replaces type in function parameters", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { createFragment, defineFragment } from "@fragno-dev/core";
        export function createMyFragment(config: MyConfig, fragnoConfig: FragnoPublicConfig) {
          return createFragment(defineFragment("mylib"), config, [], fragnoConfig);
        }"
      `);
    });

    test("ssr:true - keeps original types", () => {
      const result = transform(source, "", { ssr: true });
      expect(result.code).toMatchInlineSnapshot(`
        "import { createFragment } from "@fragno-dev/core";
        import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
        export function createMyFragment(config: MyConfig, fragnoConfig: FragnoPublicConfigWithDatabase) {
          return createFragment(defineFragmentWithDatabase("mylib"), config, [], fragnoConfig);
        }"
      `);
    });
  });

  describe("with separate import type syntax", () => {
    const source = dedent`
      import { createFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
      
      export function createMyFragment(
        fragnoConfig: FragnoPublicConfigWithDatabase,
      ) {
        return createFragment(defineFragmentWithDatabase("mylib"), {}, [], fragnoConfig);
      }
    `;

    test("ssr:false - replaces type with separate import type", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { createFragment, defineFragment } from "@fragno-dev/core";
        export function createMyFragment(fragnoConfig: FragnoPublicConfig) {
          return createFragment(defineFragment("mylib"), {}, [], fragnoConfig);
        }"
      `);
    });
  });

  describe("in type annotations", () => {
    const source = dedent`
      import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
      
      let config: FragnoPublicConfigWithDatabase;
      
      export function setConfig(c: FragnoPublicConfigWithDatabase) {
        config = c;
      }
    `;

    test("ssr:false - replaces type in annotations", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import type { FragnoPublicConfig } from "@fragno-dev/core";
        let config: FragnoPublicConfig;
        export function setConfig(c: FragnoPublicConfig) {
          config = c;
        }"
      `);
    });
  });

  describe("with existing FragnoPublicConfig import", () => {
    const source = dedent`
      import type { FragnoPublicConfig, FragnoPublicConfigWithDatabase } from "@fragno-dev/core";
      
      function useRegular(config: FragnoPublicConfig) {}
      function useDb(config: FragnoPublicConfigWithDatabase) {}
    `;

    test("ssr:false - reuses existing FragnoPublicConfig import", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import type { FragnoPublicConfig, FragnoPublicConfigWithDatabase } from "@fragno-dev/core";
        function useRegular(config: FragnoPublicConfig) {}
        function useDb(config: FragnoPublicConfigWithDatabase) {}"
      `);
    });
  });
});

describe("mixed runtime and type replacements", () => {
  const source = dedent`
    import { createFragment } from "@fragno-dev/core";
    import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema)
      .providesService(({ config, deps, orm }) => ({
        service: new Service(orm)
      }));
    
    export function createMyFragment(
      config: MyConfig,
      fragnoConfig: FragnoPublicConfigWithDatabase,
    ) {
      return createFragment(lib, config, [], fragnoConfig);
    }
  `;

  test("ssr:false - replaces both runtime and type identifiers", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toMatchInlineSnapshot(`
      "import { createFragment, defineFragment } from "@fragno-dev/core";
      const lib = defineFragment("mylib").providesService(() => {});
      export function createMyFragment(config: MyConfig, fragnoConfig: FragnoPublicConfig) {
        return createFragment(lib, config, [], fragnoConfig);
      }"
    `);
  });

  test("ssr:true - keeps original code", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toMatchInlineSnapshot(`
      "import { createFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      const lib = defineFragmentWithDatabase("mylib").withDatabase(mySchema).providesService(({
        config,
        deps,
        orm
      }) => ({
        service: new Service(orm)
      }));
      export function createMyFragment(config: MyConfig, fragnoConfig: FragnoPublicConfigWithDatabase) {
        return createFragment(lib, config, [], fragnoConfig);
      }"
    `);
  });
});

describe("edge cases", () => {
  describe("non-matching packages", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "other-package";
      import type { FragnoPublicConfigWithDatabase } from "other-package";
      
      const lib = defineFragmentWithDatabase("mylib");
      
      function useConfig(config: FragnoPublicConfigWithDatabase) {}
    `;

    test("ssr:false - does not transform non-fragno packages", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { defineFragmentWithDatabase } from "other-package";
        import type { FragnoPublicConfigWithDatabase } from "other-package";
        const lib = defineFragmentWithDatabase("mylib");
        function useConfig(config: FragnoPublicConfigWithDatabase) {}"
      `);
    });
  });

  describe("real-world example from stripe package", () => {
    const source = dedent`
      import { createFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
      import { stripeSchema } from "./database/schema";
      
      export const stripeFragmentDefinition = defineFragmentWithDatabase("stripe")
        .withDatabase(stripeSchema)
        .withDependencies(({ config }) => {
          return {
            stripe: new StripeClient(config.stripeSecretKey),
          };
        })
        .providesService(({ deps, db }) => {
          return {
            getStripeClient: () => deps.stripe,
          };
        });
      
      export function createStripeFragment(
        config: StripeConfig,
        fragnoConfig: FragnoPublicConfigWithDatabase,
      ) {
        return createFragment(
          stripeFragmentDefinition,
          config,
          [],
          fragnoConfig,
        );
      }
    `;

    test("ssr:false - transforms real-world stripe example", () => {
      const result = transform(source, "", { ssr: false });
      expect(result.code).toMatchInlineSnapshot(`
        "import { createFragment, defineFragment } from "@fragno-dev/core";
        export const stripeFragmentDefinition = defineFragment("stripe").withDependencies(() => {}).providesService(() => {});
        export function createStripeFragment(config: StripeConfig, fragnoConfig: FragnoPublicConfig) {
          return createFragment(stripeFragmentDefinition, config, [], fragnoConfig);
        }"
      `);
    });
  });
});
