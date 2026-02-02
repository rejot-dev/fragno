import { define } from "gunshi";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveFileKeyValue,
} from "../../utils/options.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export const filesUploadCommand = define({
  name: "upload",
  description: "Upload a file via the /files endpoint",
  args: {
    ...baseArgs,
    file: {
      type: "string",
      short: "f",
      description: "Path to file",
    },
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
      description: "Override filename",
    },
    "content-type": {
      type: "string",
      description: "Content type (default: application/octet-stream)",
    },
    checksum: {
      type: "string",
      description: "Checksum JSON",
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
    const filePath = ctx.values["file"] as string | undefined;
    if (!filePath) {
      throw new Error("Missing --file");
    }

    const fileBuffer = await fs.readFile(filePath);
    const filename = (ctx.values["filename"] as string | undefined) ?? path.basename(filePath);
    const contentType = (ctx.values["content-type"] as string | undefined) ?? DEFAULT_CONTENT_TYPE;

    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
    });

    const checksum = parseJsonValue("checksum", ctx.values["checksum"] as string | undefined);
    const tags = parseJsonValue("tags", ctx.values["tags"] as string | undefined);
    const metadata = parseJsonValue("metadata", ctx.values["metadata"] as string | undefined);

    const form = new FormData();
    form.append("file", new File([fileBuffer], filename, { type: contentType }));

    if (resolvedKey.fileKey) {
      form.append("fileKey", resolvedKey.fileKey);
    }
    if (resolvedKey.keyParts) {
      form.append("keyParts", JSON.stringify(resolvedKey.keyParts));
    }
    if (checksum !== undefined) {
      form.append("checksum", JSON.stringify(checksum));
    }
    if (tags !== undefined) {
      form.append("tags", JSON.stringify(tags));
    }
    if (metadata !== undefined) {
      form.append("metadata", JSON.stringify(metadata));
    }

    const uploaderId = ctx.values["uploader-id"] as string | undefined;
    if (uploaderId) {
      form.append("uploaderId", uploaderId);
    }

    const visibility = ctx.values["visibility"] as string | undefined;
    if (visibility) {
      form.append("visibility", visibility);
    }

    if (ctx.values["filename"]) {
      form.append("filename", filename);
    }

    const client = createClientFromContext(ctx);
    const response = await client.createFile(form);
    console.log(JSON.stringify(response, null, 2));
  },
});
