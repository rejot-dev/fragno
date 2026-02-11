import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineSyncCommands transform", () => {
  test("ssr:false - rewrites defineSyncCommands import to db/sync", () => {
    const source = dedent`
      import { defineFragment } from "@fragno-dev/core";
      import { defineSyncCommands, withDatabase } from "@fragno-dev/db";
      import { schema } from "@fragno-dev/db/schema";

      const mySchema = schema("my", (s) => s);

      const fragment = defineFragment("mylib")
        .extend(withDatabase(mySchema))
        .withSyncCommands(
          defineSyncCommands({ schema: mySchema }).create(({ defineCommand }) => [
            defineCommand({
              name: "ping",
              handler: () => ({ ok: true }),
            }),
          ]),
        );
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineSyncCommands } from "@fragno-dev/db/sync";
      import { defineFragment } from "@fragno-dev/core";
      import { schema } from "@fragno-dev/db/schema";
      const mySchema = schema("my", s => s);
      defineSyncCommands({
        schema: mySchema
      }).create(({
        defineCommand
      }) => [defineCommand({
        name: "ping",
        handler: () => ({
          ok: true
        })
      })]);
      const fragment = defineFragment("mylib").extend(x => x).withSyncCommands(() => {});"
    `);
  });

  test("ssr:false - preserves inline sync handlers when withSyncCommands is no-op", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { defineSyncCommands } from "@fragno-dev/db/sync";
      import { schema } from "@fragno-dev/db/schema";

      const mySchema = schema("my", (s) => s);

      const fragment = defineFragmentWithDatabase("mylib")
        .withDatabase(mySchema)
        .withSyncCommands(
          defineSyncCommands({ schema: mySchema }).create(({ defineCommand }) => [
            defineCommand({
              name: "ping",
              handler: () => ({ ok: true }),
            }),
          ]),
        )
        .withDependencies(({ config }) => ({ dep: config.dep }))
        .providesService(() => ({ svc: service }));
    `;

    const result = transform(source, "", { ssr: false });
    expect(result.code).toMatchInlineSnapshot(`
      "import { defineFragment } from "@fragno-dev/core";
      import { defineSyncCommands } from "@fragno-dev/db/sync";
      import { schema } from "@fragno-dev/db/schema";
      const mySchema = schema("my", s => s);
      defineSyncCommands({
        schema: mySchema
      }).create(({
        defineCommand
      }) => [defineCommand({
        name: "ping",
        handler: () => ({
          ok: true
        })
      })]);
      const fragment = defineFragment("mylib").withSyncCommands(() => {}).withDependencies(() => {}).providesService(() => ({
        svc: service
      }));"
    `);
  });
});
