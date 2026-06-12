import { describe, expect, it, assert } from "vitest";

import { schema, column, idColumn } from "../schema/create";
import { defineSyncCommands } from "./commands";

const testSchema = schema("sync-test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

describe("defineSyncCommands", () => {
  it("creates a registry with command map", () => {
    const registry = defineSyncCommands({ schema: testSchema }).create(({ defineCommand }) => [
      defineCommand({
        name: "ping",
        handler: async () => undefined,
      }),
    ]);

    assert(registry.schemaName === "sync-test");
    assert(registry.commands.size === 1);
    expect(registry.commands.get("ping")).toBeDefined();
    expect(registry.getCommand("ping")).toBe(registry.commands.get("ping"));
  });

  it("throws on duplicate command names", () => {
    expect(() =>
      defineSyncCommands({ schema: testSchema }).create(({ defineCommand }) => [
        defineCommand({
          name: "dup",
          handler: async () => undefined,
        }),
        defineCommand({
          name: "dup",
          handler: async () => undefined,
        }),
      ]),
    ).toThrow(/already defined/i);
  });
});
