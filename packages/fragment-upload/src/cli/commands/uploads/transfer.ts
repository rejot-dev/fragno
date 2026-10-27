import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { define } from "gunshi";

import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveFileKeyValue,
  resolveProviderValue,
} from "../../utils/options.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export const uploadsTransferCommand = define({
  name: "transfer",
  description: "Create an upload and transfer a file",
  args: {
    ...baseArgs,
    file: {
      type: "string",
      short: "f",
      description: "Path to file",
    },
    provider: {
      type: "string",
      description: "File provider namespace",
    },
    "file-key": {
      type: "string",
      description: "File key",
    },
    filename: {
      type: "string",
      description: "Override filename",
    },
    "content-type": {
      type: "string",
      description: "Content type (default: application/octet-stream)",
    },
    checksum: {
      type: "string",
      description: 'Checksum JSON, e.g. \'{"algo":"sha256","value":"..."}\'',
    },
    tags: {
      type: "string",
      description: "Tags as JSON array",
    },
    visibility: {
      type: "string",
      description: "Visibility (private, public, unlisted)",
    },
    "uploader-id": {
      type: "string",
      description: "Uploader id",
    },
    metadata: {
      type: "string",
      description: "Metadata JSON object",
    },
    "publication-mode": {
      type: "string",
      description: "Publication mode (immediate, batch)",
    },
  },
  run: async (ctx) => {
    const filePath = ctx.values.file;
    if (!filePath) {
      throw new Error("Missing --file");
    }

    const provider = resolveProviderValue(ctx.values.provider);
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"],
    });

    const stats = await fs.stat(filePath);
    const sizeBytes = stats.size;
    const filename = ctx.values.filename ?? path.basename(filePath);
    const contentType = ctx.values["content-type"] ?? DEFAULT_CONTENT_TYPE;

    const checksum = parseJsonValue("checksum", ctx.values.checksum);
    const tags = parseJsonValue("tags", ctx.values.tags);
    const metadata = parseJsonValue("metadata", ctx.values.metadata);
    const publicationMode = ctx.values["publication-mode"];
    if (
      publicationMode !== undefined &&
      publicationMode !== "immediate" &&
      publicationMode !== "batch"
    ) {
      throw new Error("Invalid --publication-mode; expected immediate or batch");
    }

    const client = createClientFromContext(ctx);
    const upload = (await client.createUpload({
      provider,
      fileKey: resolvedKey.fileKey,
      filename,
      sizeBytes,
      contentType,
      checksum,
      tags,
      visibility: ctx.values.visibility,
      uploaderId: ctx.values["uploader-id"],
      metadata,
      publicationMode,
    })) as { uploadId: string };

    const response = await client.uploadContent(
      upload.uploadId,
      Readable.toWeb(createReadStream(filePath)) as BodyInit,
      contentType,
    );
    console.log(JSON.stringify({ upload, file: response }, null, 2));
  },
});
