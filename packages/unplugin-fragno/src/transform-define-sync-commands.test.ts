import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineSyncCommands transform", () => {
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
    expect(result.code).toContain("defineSyncCommands({");
    expect(result.code).toContain('name: "ping"');
    expect(result.code).toContain("handler: () => ({");
    expect(result.code).toContain("ok: true");
    expect(result.code).toContain("withSyncCommands(() => {})");
    expect(result.code).toContain("providesService(() => ({");
    expect(result.code).toContain("svc: service");
    expect(result.code).toContain("withDependencies(() => {})");
  });
});
