import { define } from "gunshi";

import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveFileKeyValue,
  resolveProviderValue,
} from "../../utils/options.js";

export const filesUpdateCommand = define({
  name: "update",
  description: "Update file metadata",
  args: {
    ...baseArgs,
    provider: {
      type: "string",
      description: "Storage provider",
    },
    "file-key": {
      type: "string",
      description: "File key",
    },
    filename: {
      type: "string",
      description: "New filename",
    },
    visibility: {
      type: "string",
      description: "Visibility (private, public, unlisted)",
    },
    tags: {
      type: "string",
      description: "Tags JSON array or null",
    },
    metadata: {
      type: "string",
      description: "Metadata JSON object or null",
    },
  },
  run: async (ctx) => {
    const provider = resolveProviderValue(ctx.values["provider"] as string | undefined);
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
    });

    const payload: Record<string, unknown> = {};
    if (ctx.values["filename"]) {
      payload["filename"] = ctx.values["filename"] as string;
    }
    if (ctx.values["visibility"]) {
      payload["visibility"] = ctx.values["visibility"] as string;
    }
    if (ctx.values["tags"] !== undefined) {
      payload["tags"] = parseJsonValue("tags", ctx.values["tags"] as string | undefined);
    }
    if (ctx.values["metadata"] !== undefined) {
      payload["metadata"] = parseJsonValue(
        "metadata",
        ctx.values["metadata"] as string | undefined,
      );
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("Provide at least one field to update.");
    }

    const client = createClientFromContext(ctx);
    const response = await client.updateFile(provider, resolvedKey.fileKey, payload);
    console.log(JSON.stringify(response, null, 2));
  },
});
