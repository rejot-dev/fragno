import { define } from "gunshi";
import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveOptionalFileKeyValue,
} from "../../utils/options.js";

export const uploadsCreateCommand = define({
  name: "create",
  description: "Create an upload session",
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
    filename: {
      type: "string",
      description: "Filename",
    },
    "size-bytes": {
      type: "number",
      description: "Total size in bytes",
    },
    "content-type": {
      type: "string",
      description: "Content type",
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
  },
  run: async (ctx) => {
    const filename = ctx.values["filename"] as string | undefined;
    const sizeBytes = ctx.values["size-bytes"] as number | undefined;
    const contentType = ctx.values["content-type"] as string | undefined;

    if (!filename) {
      throw new Error("Missing --filename");
    }
    if (sizeBytes === undefined) {
      throw new Error("Missing --size-bytes");
    }
    if (!contentType) {
      throw new Error("Missing --content-type");
    }

    const resolvedKey = resolveOptionalFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
    });

    if (!resolvedKey.fileKey && !resolvedKey.keyParts) {
      throw new Error("Missing file key. Provide --file-key or --key-parts.");
    }

    const checksum = parseJsonValue("checksum", ctx.values["checksum"] as string | undefined);
    const tags = parseJsonValue("tags", ctx.values["tags"] as string | undefined);
    const metadata = parseJsonValue("metadata", ctx.values["metadata"] as string | undefined);

    const client = createClientFromContext(ctx);
    const response = await client.createUpload({
      fileKey: resolvedKey.fileKey,
      keyParts: resolvedKey.keyParts,
      filename,
      sizeBytes,
      contentType,
      checksum,
      tags,
      visibility: ctx.values["visibility"] as string | undefined,
      uploaderId: ctx.values["uploader-id"] as string | undefined,
      metadata,
    });

    console.log(JSON.stringify(response, null, 2));
  },
});
