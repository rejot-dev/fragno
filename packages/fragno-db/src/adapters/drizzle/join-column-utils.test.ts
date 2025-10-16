import { describe, it, expect } from "vitest";
import { getOrderedJoinColumns } from "./join-column-utils";
import { schema, column, idColumn } from "../../schema/create";

describe("getOrderedJoinColumns", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable());
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"));
      });
  });

  const usersTable = testSchema.tables["users"];
  const postsTable = testSchema.tables["posts"];

  it("should return all columns when select is true", () => {
    const columns = getOrderedJoinColumns(usersTable, true);

    // Should include all columns including hidden ones (_internalId, _version)
    expect(columns).toEqual(["id", "name", "email", "age", "_internalId", "_version"]);
  });

  it("should return selected columns plus hidden columns when select is array", () => {
    const columns = getOrderedJoinColumns(usersTable, ["name", "email"]);

    // Selected columns first, then hidden columns
    expect(columns).toEqual(["name", "email", "_internalId", "_version"]);
  });

  it("should return only id plus hidden columns when selecting just id", () => {
    const columns = getOrderedJoinColumns(usersTable, ["id"]);

    expect(columns).toEqual(["id", "_internalId", "_version"]);
  });

  it("should handle table with no nullable columns", () => {
    const columns = getOrderedJoinColumns(postsTable, true);

    expect(columns).toEqual(["id", "title", "content", "_internalId", "_version"]);
  });

  it("should handle selecting specific columns from different table", () => {
    const columns = getOrderedJoinColumns(postsTable, ["title"]);

    expect(columns).toEqual(["title", "_internalId", "_version"]);
  });

  it("should deduplicate hidden columns if already selected", () => {
    // This shouldn't happen in practice, but the function should handle it
    const columns = getOrderedJoinColumns(usersTable, ["name", "_internalId"]);

    // _internalId should not be duplicated
    expect(columns).toEqual(["name", "_internalId", "_version"]);
  });

  it("should maintain column order as defined in table", () => {
    const columns = getOrderedJoinColumns(usersTable, ["email", "name", "id"]);

    // Even though we select in different order, should follow selected order
    expect(columns).toEqual(["email", "name", "id", "_internalId", "_version"]);
  });

  it("should skip unknown column keys", () => {
    const columns = getOrderedJoinColumns(usersTable, ["name", "unknownColumn", "email"]);

    // Should only include known columns
    expect(columns).toEqual(["name", "email", "_internalId", "_version"]);
  });
});
