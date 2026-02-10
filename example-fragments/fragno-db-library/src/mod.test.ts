import { describe, expect, it } from "vitest";
import { commentFragmentDef, commentSyncCommands } from "./mod";
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

  it("should execute sync commands", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("comment", instantiate(commentFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const command = commentSyncCommands.getCommand("createComment");
    expect(command).toBeDefined();

    await test.inContext(async function () {
      await command?.handler({
        input: {
          title: "Sync comment",
          content: "Synced via command",
          postReference: "post-sync",
          userReference: "user-sync",
        },
        ctx: { mode: "server" },
        tx: (options) => this.handlerTx(options),
      });
    });

    const comments = await fragments.comment.services.getComments("post-sync");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      title: "Sync comment",
      content: "Synced via command",
      postReference: "post-sync",
      userReference: "user-sync",
    });

    await test.cleanup();
  });
});
