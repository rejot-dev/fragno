import { define } from "gunshi";

import { baseArgs, createClientFromContext, resolveFileKeyValue } from "../../utils/options.js";

export const filesGetCommand = define({
  name: "get",
  description: "Get file metadata",
  args: {
    ...baseArgs,
    "file-key": {
      type: "string",
      description: "File key",
    },
  },
  run: async (ctx) => {
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"],
    });

    const client = createClientFromContext(ctx);
    const response = await client.getFile(resolvedKey.fileKey);
    console.log(JSON.stringify(response, null, 2));
  },
});
