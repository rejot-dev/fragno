import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

export const uploadsAbortCommand = define({
  name: "abort",
  description: "Abort an upload",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const client = createClientFromContext(ctx);
    const response = await client.abortUpload(uploadId);
    console.log(JSON.stringify(response, null, 2));
  },
});
