import { define } from "gunshi";

import { baseArgs, createClientFromContext } from "../utils/options.js";
import { printResult } from "../utils/output.js";

export const repositoriesCommand = define({
  name: "repositories",
  description: "Repository commands",
});

export const repositoriesLinkedCommand = define({
  name: "linked",
  description: "List linked repositories",
  args: {
    ...baseArgs,
    "link-key": {
      type: "string",
      description: "Filter by link key",
    },
  },
  run: async (ctx) => {
    const client = createClientFromContext(ctx);
    const linkKey = ctx.values["link-key"] as string | undefined;

    const response = await client.requestJson({
      method: "GET",
      path: "/repositories/linked",
      query: linkKey ? { linkKey } : undefined,
    });

    printResult(response);
  },
});

export const repositoriesLinkCommand = define({
  name: "link",
  description: "Link a repository",
  args: {
    ...baseArgs,
    "installation-id": {
      type: "string",
      short: "i",
      description: "Installation ID",
    },
    "repo-id": {
      type: "string",
      short: "r",
      description: "Repository ID",
    },
    "link-key": {
      type: "string",
      description: "Optional link key",
    },
  },
  run: async (ctx) => {
    const installationId = ctx.values["installation-id"] as string | undefined;
    const repoId = ctx.values["repo-id"] as string | undefined;
    if (!installationId) {
      throw new Error("Missing --installation-id");
    }
    if (!repoId) {
      throw new Error("Missing --repo-id");
    }

    const client = createClientFromContext(ctx);
    const linkKey = ctx.values["link-key"] as string | undefined;

    const response = await client.requestJson({
      method: "POST",
      path: "/repositories/link",
      body: {
        installationId,
        repoId,
        linkKey: linkKey || undefined,
      },
    });

    printResult(response);
  },
});

export const repositoriesUnlinkCommand = define({
  name: "unlink",
  description: "Unlink a repository",
  args: {
    ...baseArgs,
    "repo-id": {
      type: "string",
      short: "r",
      description: "Repository ID",
    },
    "link-key": {
      type: "string",
      description: "Optional link key",
    },
  },
  run: async (ctx) => {
    const repoId = ctx.values["repo-id"] as string | undefined;
    if (!repoId) {
      throw new Error("Missing --repo-id");
    }

    const client = createClientFromContext(ctx);
    const linkKey = ctx.values["link-key"] as string | undefined;

    const response = await client.requestJson({
      method: "POST",
      path: "/repositories/unlink",
      body: {
        repoId,
        linkKey: linkKey || undefined,
      },
    });

    printResult(response);
  },
});

export const repositoriesSubCommands: Map<string, ReturnType<typeof define>> = new Map();
repositoriesSubCommands.set("linked", repositoriesLinkedCommand);
repositoriesSubCommands.set("link", repositoriesLinkCommand);
repositoriesSubCommands.set("unlink", repositoriesUnlinkCommand);
