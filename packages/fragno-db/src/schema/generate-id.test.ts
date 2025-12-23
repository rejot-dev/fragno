import { describe, it, expect } from "vitest";
import { schema, idColumn, FragnoId } from "./create";
import { generateId } from "./generate-id";

describe("generateId", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) =>
      t.addColumn("id", idColumn()).addColumn("email", "string").addColumn("name", "string"),
    ),
  );

  it("should generate a new FragnoId", () => {
    const id = generateId(testSchema, "users");

    expect(id).toBeInstanceOf(FragnoId);
    expect(id.externalId).toBeDefined();
    expect(typeof id.externalId).toBe("string");
    expect(id.externalId.length).toBeGreaterThan(0);
    expect(id.version).toBe(0);
  });

  it("should generate unique IDs on each call", () => {
    const id1 = generateId(testSchema, "users");
    const id2 = generateId(testSchema, "users");

    expect(id1.externalId).not.toBe(id2.externalId);
  });

  it("should throw for non-existent table", () => {
    expect(() => {
      // @ts-expect-error - testing runtime error for non-existent table
      generateId(testSchema, "nonexistent");
    }).toThrow("Table nonexistent not found in schema");
  });

  it("should work with multiple tables", () => {
    const multiTableSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("email", "string").addColumn("name", "string"),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("title", "string")
            .addColumn("authorId", "string"),
        ),
    );

    const userId = generateId(multiTableSchema, "users");
    const postId = generateId(multiTableSchema, "posts");

    expect(userId).toBeInstanceOf(FragnoId);
    expect(postId).toBeInstanceOf(FragnoId);
    expect(userId.externalId).not.toBe(postId.externalId);
  });
});
