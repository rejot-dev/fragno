import { define } from "gunshi";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";

export const uploadsPartsCompleteCommand = define({
  name: "parts-complete",
  description: "Record completed parts",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
    parts: {
      type: "string",
      description: "JSON array of parts (partNumber, etag, sizeBytes)",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const rawParts = parseJsonValue("parts", ctx.values["parts"] as string | undefined);
    if (!Array.isArray(rawParts) || rawParts.length === 0) {
      throw new Error("--parts must be a non-empty JSON array");
    }

    const parts = rawParts.map((part) => {
      if (!part || typeof part !== "object") {
        throw new Error("Invalid parts payload");
      }
      const payload = part as { partNumber?: unknown; etag?: unknown; sizeBytes?: unknown };
      if (typeof payload.partNumber !== "number" || !Number.isInteger(payload.partNumber)) {
        throw new Error("parts.partNumber must be an integer");
      }
      if (typeof payload.etag !== "string" || payload.etag.length === 0) {
        throw new Error("parts.etag must be a string");
      }
      if (
        typeof payload.sizeBytes !== "number" ||
        !Number.isFinite(payload.sizeBytes) ||
        !Number.isInteger(payload.sizeBytes) ||
        payload.sizeBytes < 0 ||
        payload.sizeBytes > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error("parts.sizeBytes must be a non-negative integer");
      }
      return {
        partNumber: payload.partNumber,
        etag: payload.etag,
        sizeBytes: payload.sizeBytes,
      };
    });

    const client = createClientFromContext(ctx);
    const response = await client.completeParts(uploadId, parts);
    console.log(JSON.stringify(response, null, 2));
  },
});
