import { define } from "gunshi";

import { baseArgs, createClientFromContext, resolveFileKeyValue } from "../../utils/options.js";

export const filesDeleteCommand = define({
  name: "delete",
  description: "Delete a file",
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
    const response = await client.deleteFile(resolvedKey.fileKey);
    console.log(JSON.stringify(response, null, 2));
  },
});
