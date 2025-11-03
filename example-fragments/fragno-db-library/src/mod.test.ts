import { describe, expect, it } from "vitest";
import { commentFragmentDef } from "./mod";
import { createDatabaseFragmentForTest } from "@fragno-dev/test";

describe("comment-fragment", async () => {
  const { fragment } = await createDatabaseFragmentForTest(
    { definition: commentFragmentDef, routes: [] },
    {
      adapter: { type: "kysely-sqlite" },
    },
  );

  it("should run queries", async () => {
    const query = await fragment.services.createComment({
      title: "Test comment",
      content: "Test content",
      postReference: "123",
      userReference: "456",
    });

    expect(query).toMatchObject({
      id: expect.any(String),
      title: "Test comment",
      content: "Test content",
      postReference: "123",
      userReference: "456",
    });

    const comments = await fragment.services.getComments("123");
    expect(comments).toMatchObject([query]);
  });
});
