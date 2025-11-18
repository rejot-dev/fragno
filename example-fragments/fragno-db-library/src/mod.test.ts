import { describe, expect, it } from "vitest";
import { commentFragmentDef } from "./mod";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";

describe("comment-fragment", () => {
  it("should run queries", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("comment", instantiate(commentFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const query = await fragments.comment.services.createComment({
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

    const comments = await fragments.comment.services.getComments("123");
    expect(comments).toMatchObject([query]);

    await test.cleanup();
  });
});
