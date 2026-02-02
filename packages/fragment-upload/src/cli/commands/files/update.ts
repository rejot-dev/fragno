import { define } from "gunshi";
import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveFileKeyValue,
} from "../../utils/options.js";

export const filesUpdateCommand = define({
  name: "update",
  description: "Update file metadata",
  args: {
    ...baseArgs,
    "file-key": {
      type: "string",
      description: "File key (encoded)",
    },
    "key-parts": {
      type: "string",
      description: "File key parts as JSON array",
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
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
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
    const response = await client.updateFile(resolvedKey.fileKey, payload);
    console.log(JSON.stringify(response, null, 2));
  },
});
