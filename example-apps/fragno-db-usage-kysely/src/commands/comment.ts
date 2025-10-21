import type { Command } from "gunshi";
import { createFragnoDatabaseLibrary } from "@fragno-dev/fragno-db-library";
import { createAdapter } from "../fragno/comment-fragment";

export async function getCommentClient() {
  const adapter = createAdapter();
  const orm = adapter.createQueryEngine(
    (await import("@fragno-dev/fragno-db-library")).commentSchema,
    "fragno-db-comment-db",
  );
  return createFragnoDatabaseLibrary(orm);
}

const commentCreateCommand: Command = {
  name: "create",
  description: "Create a new comment",
  args: {
    title: {
      type: "string" as const,
      description: "Comment title",
      required: true as const,
    },
    content: {
      type: "string" as const,
      description: "Comment content",
      required: true as const,
    },
    postReference: {
      type: "string" as const,
      description: "Post reference ID",
      required: true as const,
    },
    userReference: {
      type: "string" as const,
      description: "User reference ID",
      required: true as const,
    },
    parentId: {
      type: "string" as const,
      description: "Parent comment ID (optional)",
    },
  },
  run: async (ctx) => {
    const libraryClient = await getCommentClient();
    const comment = await libraryClient.createComment({
      title: ctx.values["title"] as string,
      content: ctx.values["content"] as string,
      postReference: ctx.values["postReference"] as string,
      userReference: ctx.values["userReference"] as string,
    });
    console.log("Created comment:");
    console.log(JSON.stringify(comment, null, 2));
  },
};

const commentListCommand: Command = {
  name: "list",
  description: "List comments for a post",
  args: {
    postReference: {
      type: "string" as const,
      description: "Post reference ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const libraryClient = await getCommentClient();
    const postReference = ctx.values["postReference"] as string;
    const comments = await libraryClient.getComments(postReference);
    console.log(`Comments for post ${postReference}:`);
    console.log(JSON.stringify(comments, null, 2));
  },
};

export const commentSubCommands = new Map();
commentSubCommands.set("create", commentCreateCommand);
commentSubCommands.set("list", commentListCommand);

export const commentCommand: Command = {
  name: "comment",
  description: "Comment management commands",
  run: () => {
    console.log("Comment management commands");
    console.log("");
    console.log("Usage: bun run src/mod.ts comment <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  create    Create a new comment");
    console.log("  list      List comments for a post");
    console.log("");
    console.log("Run 'bun run src/mod.ts comment <command> --help' for more information.");
  },
};
