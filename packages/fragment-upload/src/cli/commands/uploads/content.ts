import { define } from "gunshi";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { baseArgs, createClientFromContext } from "../../utils/options.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export const uploadsContentCommand = define({
  name: "content",
  description: "Upload file bytes via proxy upload",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
    file: {
      type: "string",
      short: "f",
      description: "Path to file",
    },
    "content-type": {
      type: "string",
      description: "Content type (default: application/octet-stream)",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const filePath = ctx.values["file"] as string | undefined;
    if (!filePath) {
      throw new Error("Missing --file");
    }

    const contentType = (ctx.values["content-type"] as string | undefined) ?? DEFAULT_CONTENT_TYPE;

    const client = createClientFromContext(ctx);
    const stream = createReadStream(filePath);
    const response = await client.uploadContent(
      uploadId,
      Readable.toWeb(stream) as BodyInit,
      contentType,
    );
    console.log(JSON.stringify(response, null, 2));
  },
});
