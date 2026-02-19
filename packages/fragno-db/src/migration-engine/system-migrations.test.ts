import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "../schema/create";
import {
  buildSystemMigrationOperations,
  resolveSystemMigrationRange,
  type SystemMigration,
} from "./system-migrations";

describe("buildSystemMigrationOperations", () => {
  const testSchema = schema("test", (s) => {
    return s.addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    });
  });

  const context = {
    schema: testSchema,
    namespace: "test",
  };

  it("filters empty statements and slices by version", () => {
    const migrations: SystemMigration[] = [
      () => "select 1",
      () => ["", "  ", "select 2"],
      () => undefined,
      () => "select 3",
    ];

    const operations = buildSystemMigrationOperations(migrations, context, 1, 3);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toEqual({ type: "custom", sql: "select 2" });
  });

  it("returns empty array when fromVersion equals toVersion", () => {
    const migrations: SystemMigration[] = [() => "select 1"];

    const operations = buildSystemMigrationOperations(migrations, context, 1, 1);

    expect(operations).toEqual([]);
  });
});

describe("resolveSystemMigrationRange", () => {
  it("returns null when systemFromVersion is undefined", () => {
    const result = resolveSystemMigrationRange([], undefined);

    expect(result).toBeNull();
  });

  it("throws when systemToVersion is provided without systemFromVersion", () => {
    expect(() => resolveSystemMigrationRange([], undefined, 1)).toThrow(
      "systemToVersion requires systemFromVersion.",
    );
  });

  it("defaults to migrations length when systemToVersion is omitted", () => {
    const result = resolveSystemMigrationRange([() => "select 1"], 0);

    expect(result).toEqual({ fromVersion: 0, toVersion: 1 });
  });

  it("throws when systemFromVersion is negative", () => {
    expect(() => resolveSystemMigrationRange([() => "select 1"], -1)).toThrow(
      "systemFromVersion cannot be negative: -1",
    );
  });

  it("throws when systemToVersion is negative", () => {
    expect(() => resolveSystemMigrationRange([() => "select 1"], 0, -1)).toThrow(
      "systemToVersion cannot be negative: -1",
    );
  });

  it("throws when systemToVersion is less than systemFromVersion", () => {
    expect(() => resolveSystemMigrationRange([() => "select 1"], 2, 1)).toThrow(
      "Cannot migrate system versions backwards: from 2 to 1",
    );
  });

  it("throws when systemFromVersion exceeds migrations length", () => {
    expect(() => resolveSystemMigrationRange([() => "select 1"], 2, 2)).toThrow(
      "systemFromVersion (2) exceeds system migrations length (1)",
    );
  });

  it("throws when systemToVersion exceeds migrations length", () => {
    expect(() => resolveSystemMigrationRange([() => "select 1"], 0, 2)).toThrow(
      "systemToVersion (2) exceeds system migrations length (1)",
    );
  });
});
