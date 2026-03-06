import { define } from "gunshi";

import { baseArgs, createClientFromContext } from "../utils/options.js";
import { printResult } from "../utils/output.js";

export const installationsCommand = define({
  name: "installations",
  description: "Installation commands",
});

export const installationsListCommand = define({
  name: "list",
  description: "List installations",
  args: {
    ...baseArgs,
    status: {
      type: "string",
      description: "Filter by status (active, suspended, deleted)",
    },
  },
  run: async (ctx) => {
    const client = createClientFromContext(ctx);
    const status = ctx.values["status"] as string | undefined;

    const response = await client.requestJson({
      method: "GET",
      path: "/installations",
      query: status ? { status } : undefined,
    });

    printResult(response);
  },
});

export const installationsReposCommand = define({
  name: "repos",
  description: "List repositories for an installation",
  args: {
    ...baseArgs,
    "installation-id": {
      type: "string",
      short: "i",
      description: "Installation ID",
    },
    "linked-only": {
      type: "boolean",
      description: "Only include linked repositories",
    },
    "link-key": {
      type: "string",
      description: "Filter by link key",
    },
  },
  run: async (ctx) => {
    const installationId = ctx.values["installation-id"] as string | undefined;
    if (!installationId) {
      throw new Error("Missing --installation-id");
    }

    const client = createClientFromContext(ctx);
    const linkedOnly = ctx.values["linked-only"] as boolean | undefined;
    const linkKey = ctx.values["link-key"] as string | undefined;

    const query: Record<string, string> = {};
    if (linkedOnly) {
      query["linkedOnly"] = "true";
    }
    if (linkKey) {
      query["linkKey"] = linkKey;
    }

    const response = await client.requestJson({
      method: "GET",
      path: `/installations/${encodeURIComponent(installationId)}/repos`,
      query: Object.keys(query).length > 0 ? query : undefined,
    });

    printResult(response);
  },
});

export const installationsSyncCommand = define({
  name: "sync",
  description: "Sync repositories for an installation from GitHub",
  args: {
    ...baseArgs,
    "installation-id": {
      type: "string",
      short: "i",
      description: "Installation ID",
    },
  },
  run: async (ctx) => {
    const installationId = ctx.values["installation-id"] as string | undefined;
    if (!installationId) {
      throw new Error("Missing --installation-id");
    }

    const client = createClientFromContext(ctx);
    const response = await client.requestJson({
      method: "POST",
      path: `/installations/${encodeURIComponent(installationId)}/sync`,
    });

    printResult(response);
  },
});

export const installationsSubCommands: Map<string, ReturnType<typeof define>> = new Map();
installationsSubCommands.set("list", installationsListCommand);
installationsSubCommands.set("repos", installationsReposCommand);
installationsSubCommands.set("sync", installationsSyncCommand);
