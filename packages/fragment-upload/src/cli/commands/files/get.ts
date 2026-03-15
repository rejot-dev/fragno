import { define } from "gunshi";

import {
  baseArgs,
  createClientFromContext,
  resolveFileKeyValue,
  resolveProviderValue,
} from "../../utils/options.js";

export const filesGetCommand = define({
  name: "get",
  description: "Get file metadata",
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
  },
  run: async (ctx) => {
    const provider = resolveProviderValue(ctx.values["provider"] as string | undefined);
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
    });

    const client = createClientFromContext(ctx);
    const response = await client.getFile(provider, resolvedKey.fileKey);
    console.log(JSON.stringify(response, null, 2));
  },
});
