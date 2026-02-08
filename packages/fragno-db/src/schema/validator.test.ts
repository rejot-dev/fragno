import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import {
  FragnoDbValidationError,
  FragnoId,
  FragnoReference,
  column,
  idColumn,
  referenceColumn,
  schema,
} from "./create";

const testSchema = schema("validation", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("age", column("integer").nullable())
        .addColumn("status", column("string").defaultTo("active"));
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn())
        .addColumn("title", column("varchar(10)"));
    })
    .addTable("all_types", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("nickname", column("varchar(5)"))
        .addColumn("age", column("integer"))
        .addColumn("score", column("decimal"))
        .addColumn("active", column("bool"))
        .addColumn("bytes", column("binary"))
        .addColumn("createdAt", column("timestamp"))
        .addColumn("birthday", column("date"))
        .addColumn("data", column("json"))
        .addColumn("bigValue", column("bigint"))
        .addColumn("ref", referenceColumn())
        .addColumn("optionalWithDefault", column("string").defaultTo("x"))
        .addColumn("optionalNullable", column("string").nullable());
    });
});

const getIssues = async <Output>(
  result: StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
) => {
  const resolved = await result;
  if (!("issues" in resolved) || !resolved.issues) {
    throw new Error("Expected validation issues");
  }

  return resolved.issues;
};

const validAllTypes = () => ({
  id: "id-1",
  name: "Ada",
  nickname: "Ada",
  age: 30,
  score: 12.5,
  active: true,
  bytes: new Uint8Array([1, 2, 3]),
  createdAt: new Date(),
  birthday: new Date("2000-01-01"),
  data: { ok: true },
  bigValue: 10n,
  ref: "user-1",
});

describe("table validation", () => {
  it("strips unknown keys by default", () => {
    const users = testSchema.tables.users;
    const result = users.validate({ id: "user-1", name: "Ada", extra: "nope" } as never);
    expect(result).toEqual({ id: "user-1", name: "Ada" });
  });

  it("supports strict unknown keys via Standard Schema options", async () => {
    const users = testSchema.tables.users;
    const result = users["~standard"].validate(
      { id: "user-1", name: "Ada", extra: "nope" },
      { libraryOptions: { unknownKeys: "strict" } },
    );

    const issues = await getIssues(result);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("treats defaults as optional", () => {
    const users = testSchema.tables.users;
    expect(() => users.validate({ id: "user-1", name: "Ada" })).not.toThrow();
  });

  it("allows null for nullable columns", () => {
    const users = testSchema.tables.users;
    expect(() => users.validate({ id: "user-1", name: "Ada", age: null })).not.toThrow();
  });

  it("throws on missing required fields", () => {
    const users = testSchema.tables.users;
    expect(() => users.validate({} as never)).toThrow(FragnoDbValidationError);
  });

  it("accepts all supported column types", () => {
    const allTypes = testSchema.tables.all_types;
    const payload = validAllTypes();
    const result = allTypes.validate(payload);
    expect(result).toEqual(payload);
  });

  it("rejects non-object input", async () => {
    const allTypes = testSchema.tables.all_types;
    const result = allTypes["~standard"].validate("nope");
    const issues = await getIssues(result);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("validates string and varchar length", async () => {
    const users = testSchema.tables.users;
    const posts = testSchema.tables.posts;

    const longId = "a".repeat(31);
    const longTitleResult = posts["~standard"].validate({
      id: "post-1",
      userId: "user-1",
      title: "this is too long",
    });
    expect((await getIssues(longTitleResult)).length).toBeGreaterThan(0);

    const longIdResult = users["~standard"].validate({ id: longId, name: "Ada" });
    expect((await getIssues(longIdResult)).length).toBeGreaterThan(0);

    const longIdFragno = new FragnoId({ externalId: longId, version: 1 });
    const longFragnoResult = users["~standard"].validate({ id: longIdFragno, name: "Ada" });
    expect((await getIssues(longFragnoResult)).length).toBeGreaterThan(0);
  });

  it("accepts and rejects reference values", async () => {
    const posts = testSchema.tables.posts;

    const ref = FragnoReference.fromInternal(1n);
    const post = posts.validate({ id: "post-1", userId: ref, title: "hello" });
    expect(post.userId).toBe(ref);

    const fragnoId = FragnoId.fromExternal("user-1", 1);
    expect(() => posts.validate({ id: "post-1", userId: fragnoId, title: "hello" })).not.toThrow();
    expect(() => posts.validate({ id: "post-1", userId: 1n, title: "hello" })).not.toThrow();

    const invalidRefResult = posts["~standard"].validate({
      id: "post-1",
      userId: { id: 1 },
      title: "hello",
    });
    expect((await getIssues(invalidRefResult)).length).toBeGreaterThan(0);
  });

  it("accepts FragnoId values for id columns", () => {
    const users = testSchema.tables.users;
    const userId = FragnoId.fromExternal("user-1", 1);
    const user = users.validate({ id: userId, name: "Ada" });
    expect(user.id).toBe(userId);
  });

  it("validates integer, decimal, bool, bigint, binary, date, and timestamp", async () => {
    const allTypes = testSchema.tables.all_types;

    const invalidCases = [
      { key: "name", value: 123 },
      { key: "nickname", value: "toolong" },
      { key: "age", value: 1.2 },
      { key: "score", value: Number.NaN },
      { key: "active", value: "true" },
      { key: "bigValue", value: 1 },
      { key: "bytes", value: "nope" },
      { key: "createdAt", value: new Date("invalid") },
      { key: "birthday", value: new Date("invalid") },
    ] as const;

    for (const testCase of invalidCases) {
      const value = { ...validAllTypes(), [testCase.key]: testCase.value } as never;
      const result = allTypes["~standard"].validate(value);
      expect((await getIssues(result)).length).toBeGreaterThan(0);
    }
  });

  it("rejects null for non-nullable fields", async () => {
    const allTypes = testSchema.tables.all_types;
    const result = allTypes["~standard"].validate({
      ...validAllTypes(),
      name: null,
    });

    expect((await getIssues(result)).length).toBeGreaterThan(0);
  });
});
