import { define } from "gunshi";
import { baseArgs, createClientFromContext, parseJsonValue } from "../../utils/options.js";

const parsePartNumbers = (rawParts: unknown, rawPart: unknown): number[] => {
  const parts: number[] = [];

  if (rawParts) {
    const parsed = parseJsonValue("parts", String(rawParts));
    if (!Array.isArray(parsed)) {
      throw new Error("--parts must be a JSON array of numbers");
    }
    for (const value of parsed) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("--parts must be a JSON array of positive integers");
      }
      parts.push(value);
    }
  }

  if (rawPart) {
    const items = Array.isArray(rawPart) ? rawPart : [rawPart];
    for (const value of items) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--part must be a positive integer");
      }
      parts.push(parsed);
    }
  }

  return Array.from(new Set(parts));
};

export const uploadsPartsUrlsCommand = define({
  name: "parts-urls",
  description: "Get signed URLs for multipart upload",
  args: {
    ...baseArgs,
    "upload-id": {
      type: "string",
      short: "i",
      description: "Upload id",
    },
    parts: {
      type: "string",
      description: "JSON array of part numbers",
    },
    part: {
      type: "number",
      multiple: true,
      description: "Part number (repeatable)",
    },
  },
  run: async (ctx) => {
    const uploadId = ctx.values["upload-id"] as string | undefined;
    if (!uploadId) {
      throw new Error("Missing --upload-id");
    }

    const partNumbers = parsePartNumbers(ctx.values["parts"], ctx.values["part"]);
    if (!partNumbers.length) {
      throw new Error("Provide --parts or at least one --part");
    }

    const client = createClientFromContext(ctx);
    const response = await client.getPartUrls(uploadId, partNumbers);
    console.log(JSON.stringify(response, null, 2));
  },
});
