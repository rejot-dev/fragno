import { define } from "gunshi";

import {
  baseArgs,
  createClientFromContext,
  resolveFileKeyValue,
  resolveProviderValue,
} from "../../utils/options.js";

export const filesDownloadUrlCommand = define({
  name: "download-url",
  description: "Get a signed download URL",
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
    const response = await client.getDownloadUrl(provider, resolvedKey.fileKey);
    console.log(JSON.stringify(response, null, 2));
  },
});
