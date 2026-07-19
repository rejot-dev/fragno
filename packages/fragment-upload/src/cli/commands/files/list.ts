import { define } from "gunshi";

import { baseArgs, createClientFromContext, resolvePrefixValue } from "../../utils/options.js";

export const filesListCommand = define({
  name: "list",
  description: "List files",
  args: {
    ...baseArgs,
    provider: {
      type: "string",
      description: "Filter by storage provider",
    },
    prefix: {
      type: "string",
      description: "File key prefix",
    },
    cursor: {
      type: "string",
      description: "Cursor for pagination",
    },
    "page-size": {
      type: "number",
      description: "Page size for pagination",
    },
    status: {
      type: "string",
      description: "Filter by status (ready, deleted)",
    },
    "uploader-id": {
      type: "string",
      description: "Filter by uploader id",
    },
  },
  run: async (ctx) => {
    const prefix = resolvePrefixValue({
      prefix: ctx.values.prefix,
    });

    const client = createClientFromContext(ctx);
    const response = await client.listFiles({
      provider: ctx.values.provider,
      prefix,
      cursor: ctx.values.cursor,
      pageSize: ctx.values["page-size"],
      status: ctx.values.status,
      uploaderId: ctx.values["uploader-id"],
    });

    console.log(JSON.stringify(response, null, 2));
  },
});
