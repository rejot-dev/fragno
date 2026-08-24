import { describe, expect, test } from "vitest";

import { DurableObjectDialect } from "./durable-object-dialect";

describe("Durable Object SQLite dialect", () => {
  test("rejects database introspection explicitly", () => {
    const dialect = new DurableObjectDialect({
      ctx: { storage: { sql: {} } },
    } as never);

    expect(() => dialect.createIntrospector({} as never)).toThrow(
      "Durable Object SQLite introspection is not supported.",
    );
  });
});
