import { define } from "gunshi";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";

export const uploadsCompleteCommand = define({
  name: "complete",
  description: "Complete an upload",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
    parts: {
      type: "string",
      description: "JSON array of parts (partNumber, etag) for multipart uploads",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const rawParts = parseJsonValue("parts", ctx.values["parts"] as string | undefined);
    let parts: { partNumber: number; etag: string }[] | undefined;

    if (rawParts !== undefined) {
      if (!Array.isArray(rawParts) || rawParts.length === 0) {
        throw new Error("--parts must be a non-empty JSON array");
      }
      parts = rawParts.map((part) => {
        if (!part || typeof part !== "object") {
          throw new Error("Invalid parts payload");
        }
        const payload = part as { partNumber?: unknown; etag?: unknown };
        if (typeof payload.partNumber !== "number" || !Number.isInteger(payload.partNumber)) {
          throw new Error("parts.partNumber must be an integer");
        }
        if (typeof payload.etag !== "string" || payload.etag.length === 0) {
          throw new Error("parts.etag must be a string");
        }
        return {
          partNumber: payload.partNumber,
          etag: payload.etag,
        };
      });
    }

    const client = createClientFromContext(ctx);
    const response = await client.completeUpload(uploadId, parts);
    console.log(JSON.stringify(response, null, 2));
  },
});
