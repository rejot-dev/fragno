import type { Command } from "gunshi";
import { createCommentFragmentServer } from "../fragno/comment-fragment";

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
    const services = createCommentFragmentServer().services;

    const comment = await services.createComment({
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
    const services = createCommentFragmentServer().services;
    const postReference = ctx.values["postReference"] as string;
    const comments = await services.getComments(postReference);
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
    console.log("Usage: node --import tsx src/mod.ts comment <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  create    Create a new comment");
    console.log("  list      List comments for a post");
    console.log("");
    console.log(
      "Run 'node --import tsx src/mod.ts comment <command> --help' for more information.",
    );
  },
};
