import { define } from "gunshi";

import { baseArgs, createClientFromContext, parseJsonValue } from "../utils/options.js";
import { printResult } from "../utils/output.js";

export const pullsCommand = define({
  name: "pulls",
  description: "Pull request commands",
});

export const pullsListCommand = define({
  name: "list",
  description: "List pull requests",
  args: {
    ...baseArgs,
    owner: {
      type: "string",
      description: "Repository owner",
    },
    repo: {
      type: "string",
      description: "Repository name",
    },
    state: {
      type: "string",
      description: "State filter (open, closed, all)",
    },
    "per-page": {
      type: "number",
      description: "Results per page (1-100)",
    },
    page: {
      type: "number",
      description: "Page number",
    },
  },
  run: async (ctx) => {
    const owner = ctx.values["owner"] as string | undefined;
    const repo = ctx.values["repo"] as string | undefined;

    if (!owner) {
      throw new Error("Missing --owner");
    }
    if (!repo) {
      throw new Error("Missing --repo");
    }

    const client = createClientFromContext(ctx);
    const state = ctx.values["state"] as string | undefined;
    const perPage = ctx.values["per-page"] as number | undefined;
    const page = ctx.values["page"] as number | undefined;

    const query: Record<string, string> = {};
    if (state) {
      query["state"] = state;
    }
    if (perPage !== undefined) {
      query["perPage"] = String(perPage);
    }
    if (page !== undefined) {
      query["page"] = String(page);
    }

    const response = await client.requestJson({
      method: "GET",
      path: `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      query: Object.keys(query).length > 0 ? query : undefined,
    });

    printResult(response);
  },
});

export const pullsReviewCommand = define({
  name: "review",
  description: "Create a pull request review",
  args: {
    ...baseArgs,
    owner: {
      type: "string",
      description: "Repository owner",
    },
    repo: {
      type: "string",
      description: "Repository name",
    },
    number: {
      type: "number",
      description: "Pull request number",
    },
    event: {
      type: "string",
      description: "Review event (APPROVE, REQUEST_CHANGES, COMMENT)",
    },
    body: {
      type: "string",
      description: "Review body",
    },
    comments: {
      type: "string",
      description: "Review comments JSON array",
    },
    "commit-id": {
      type: "string",
      description: "Commit id",
    },
  },
  run: async (ctx) => {
    const owner = ctx.values["owner"] as string | undefined;
    const repo = ctx.values["repo"] as string | undefined;
    const number = ctx.values["number"] as number | undefined;

    if (!owner) {
      throw new Error("Missing --owner");
    }
    if (!repo) {
      throw new Error("Missing --repo");
    }
    if (!number) {
      throw new Error("Missing --number");
    }

    const event = ctx.values["event"] as string | undefined;
    if (event && !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) {
      throw new Error("Invalid --event. Use APPROVE, REQUEST_CHANGES, or COMMENT.");
    }

    const comments = parseJsonValue("comments", ctx.values["comments"] as string | undefined);
    if (comments !== undefined && !Array.isArray(comments)) {
      throw new Error("--comments must be a JSON array");
    }

    const client = createClientFromContext(ctx);

    const response = await client.requestJson({
      method: "POST",
      path: `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
      body: {
        event: event || undefined,
        body: ctx.values["body"] as string | undefined,
        comments: comments as unknown[] | undefined,
        commitId: ctx.values["commit-id"] as string | undefined,
      },
    });

    printResult(response);
  },
});

export const pullsSubCommands: Map<string, ReturnType<typeof define>> = new Map();
pullsSubCommands.set("list", pullsListCommand);
pullsSubCommands.set("review", pullsReviewCommand);
