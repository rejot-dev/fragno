import { assert, describe, expect, it } from "vitest";

import { inlineSqliteParams } from "./inline";
import { openLofiSqliteMemoryFiles } from "./testing";

describe("inlineSqliteParams", () => {
  it("stores every inlined value exactly as the bound value", async () => {
    const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
    const database = await files.open({ databaseName: "inline.sqlite" });
    const values: unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      -0,
      7,
      -7,
      2 ** 31 - 1,
      -(2 ** 31),
      2n ** 63n - 1n,
      -(2n ** 63n) + 1n,
      -5n,
      "",
      "it's",
      `"quoted" ? :name -- not a comment; /* nor this */`,
      "naïve 🦊",
      new Uint8Array([0, 1, 254, 255]),
    ];
    for (const value of values) {
      const inlined = inlineSqliteParams(`SELECT ? AS "value", typeof(?) AS "type"`, [
        value,
        value,
      ]);
      expect(inlined, String(value)).not.toBeNull();
      expect(await database.execute(inlined!)).toEqual(
        await database.execute(`SELECT ? AS "value", typeof(?) AS "type"`, [value, value]),
      );
    }
    await database.close();
  });

  it("subtracts a negative value instead of starting a comment", () => {
    assert.strictEqual(inlineSqliteParams(`SELECT 1 -?`, [-1]), `SELECT 1 -(-1)`);
  });

  it("keeps question marks and quotes inside strings and identifiers", () => {
    assert.strictEqual(
      inlineSqliteParams(`SELECT 'what?' AS "why?""", ? FROM "t" WHERE "a" = ?`, ["x", 1]),
      `SELECT 'what?' AS "why?""", 'x' FROM "t" WHERE "a" = 1`,
    );
  });

  it("leaves a statement to run on its own when inlining could change it", () => {
    for (const [sql, params] of [
      // SQLite may round a fraction's decimal text differently from the bound double.
      [`SELECT ?`, [0.1]],
      [`SELECT ?`, [2 ** 40]],
      [`SELECT ?`, [-(2n ** 63n)]],
      [`SELECT ?`, [2n ** 63n]],
      [`SELECT ?`, ["a\u0000b"]],
      [`SELECT ?`, [new Uint8Array()]],
      [`SELECT ?`, [new Date(0)]],
      [`SELECT ?`, [[1, 2]]],
      [`SELECT ?1`, [1]],
      [`SELECT :value`, [1]],
      [`SELECT ?`, []],
      [`SELECT ?, ?`, [1]],
      [`SELECT ?`, [1, 2]],
      [`SELECT 1; SELECT 2`, []],
      [`SELECT 1;`, []],
      [`SELECT 1 -- ?`, []],
      [`SELECT /* ' */ ?`, [1]],
      [`SELECT 'unterminated`, []],
      [`  `, []],
    ] as const) {
      expect(inlineSqliteParams(sql, params), sql).toBeNull();
    }
  });
});
