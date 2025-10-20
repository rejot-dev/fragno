import type { Command } from "gunshi";
import * as repo from "../repository";

const postCreateCommand: Command = {
  name: "create",
  description: "Create a new blog post",
  args: {
    title: {
      type: "string" as const,
      description: "Post title",
      required: true as const,
    },
    content: {
      type: "string" as const,
      description: "Post content",
      required: true as const,
    },
    authorId: {
      type: "number" as const,
      description: "Author user ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const post = await repo.createBlogPost({
      title: ctx.values["title"] as string,
      content: ctx.values["content"] as string,
      authorId: ctx.values["authorId"] as number,
    });
    console.log("Created blog post:");
    console.log(JSON.stringify(post, null, 2));
  },
};

const postListCommand: Command = {
  name: "list",
  description: "List all blog posts",
  run: async () => {
    const posts = await repo.findAllBlogPosts();
    console.log("Blog posts:");
    console.log(JSON.stringify(posts, null, 2));
  },
};

const postListWithAuthorCommand: Command = {
  name: "list-with-author",
  description: "List all blog posts with author details",
  run: async () => {
    const posts = await repo.findBlogPostsWithAuthor();
    console.log("Blog posts with authors:");
    console.log(JSON.stringify(posts, null, 2));
  },
};

const postGetCommand: Command = {
  name: "get",
  description: "Get a blog post by ID",
  args: {
    id: {
      type: "number" as const,
      description: "Post ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const post = await repo.findBlogPostById(id);
    if (post) {
      console.log("Blog post:");
      console.log(JSON.stringify(post, null, 2));
    } else {
      console.log(`Blog post with ID ${id} not found.`);
    }
  },
};

const postListByAuthorCommand: Command = {
  name: "list-by-author",
  description: "List blog posts by author",
  args: {
    authorId: {
      type: "number" as const,
      description: "Author user ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const authorId = ctx.values["authorId"] as number;
    const posts = await repo.findBlogPostsByAuthor(authorId);
    console.log(`Blog posts by author ${authorId}:`);
    console.log(JSON.stringify(posts, null, 2));
  },
};

const postSearchCommand: Command = {
  name: "search",
  description: "Search blog posts by title",
  args: {
    query: {
      type: "string" as const,
      description: "Search query",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const query = ctx.values["query"] as string;
    const posts = await repo.searchBlogPostsByTitle(query);
    console.log(`Blog posts matching "${query}":`);
    console.log(JSON.stringify(posts, null, 2));
  },
};

const postUpdateCommand: Command = {
  name: "update",
  description: "Update a blog post",
  args: {
    id: {
      type: "number" as const,
      description: "Post ID",
      required: true as const,
    },
    title: {
      type: "string" as const,
      description: "New title",
    },
    content: {
      type: "string" as const,
      description: "New content",
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const updates: { title?: string; content?: string } = {};

    if (ctx.values["title"]) {
      updates.title = ctx.values["title"] as string;
    }
    if (ctx.values["content"]) {
      updates.content = ctx.values["content"] as string;
    }

    await repo.updateBlogPost(id, updates);
    console.log(`Blog post ${id} updated successfully.`);

    const post = await repo.findBlogPostById(id);
    if (post) {
      console.log(JSON.stringify(post, null, 2));
    }
  },
};

const postDeleteCommand: Command = {
  name: "delete",
  description: "Delete a blog post",
  args: {
    id: {
      type: "number" as const,
      description: "Post ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const deletedPost = await repo.deleteBlogPost(id);
    if (deletedPost) {
      console.log("Deleted blog post:");
      console.log(JSON.stringify(deletedPost, null, 2));
    } else {
      console.log(`Blog post with ID ${id} not found.`);
    }
  },
};

export const postSubCommands = new Map();
postSubCommands.set("create", postCreateCommand);
postSubCommands.set("list", postListCommand);
postSubCommands.set("list-with-author", postListWithAuthorCommand);
postSubCommands.set("get", postGetCommand);
postSubCommands.set("list-by-author", postListByAuthorCommand);
postSubCommands.set("search", postSearchCommand);
postSubCommands.set("update", postUpdateCommand);
postSubCommands.set("delete", postDeleteCommand);

export const postCommand: Command = {
  name: "post",
  description: "Blog post management commands",
  run: () => {
    console.log("Blog post management commands");
    console.log("");
    console.log("Usage: bun run src/mod.ts post <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  create             Create a new blog post");
    console.log("  list               List all blog posts");
    console.log("  list-with-author   List all blog posts with author details");
    console.log("  get                Get a blog post by ID");
    console.log("  list-by-author     List blog posts by author");
    console.log("  search             Search blog posts by title");
    console.log("  update             Update a blog post");
    console.log("  delete             Delete a blog post");
    console.log("");
    console.log("Run 'bun run src/mod.ts post <command> --help' for more information.");
  },
};
