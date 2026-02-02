import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

export const uploadsProgressCommand = define({
  name: "progress",
  description: "Record upload progress",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
    "bytes-uploaded": {
      type: "number",
      description: "Total bytes uploaded",
    },
    "parts-uploaded": {
      type: "number",
      description: "Total parts uploaded",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const bytesUploaded = ctx.values["bytes-uploaded"] as number | undefined;
    const partsUploaded = ctx.values["parts-uploaded"] as number | undefined;

    if (bytesUploaded === undefined && partsUploaded === undefined) {
      throw new Error("Provide --bytes-uploaded, --parts-uploaded, or both.");
    }

    const client = createClientFromContext(ctx);
    const response = await client.reportProgress(uploadId, { bytesUploaded, partsUploaded });
    console.log(JSON.stringify(response, null, 2));
  },
});
