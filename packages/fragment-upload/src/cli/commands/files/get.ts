import { define } from "gunshi";
import { baseArgs, createClientFromContext, resolveFileKeyValue } from "../../utils/options.js";

export const filesGetCommand = define({
  name: "get",
  description: "Get file metadata",
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
  },
  run: async (ctx) => {
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
    });

    const client = createClientFromContext(ctx);
    const response = await client.getFile(resolvedKey.fileKey);
    console.log(JSON.stringify(response, null, 2));
  },
});
