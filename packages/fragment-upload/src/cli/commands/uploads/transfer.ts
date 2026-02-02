import { define } from "gunshi";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  baseArgs,
  createClientFromContext,
  parseJsonValue,
  resolveOptionalFileKeyValue,
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
    const filePath = ctx.values["file"] as string | undefined;
    if (!filePath) {
      throw new Error("Missing --file");
    }

    const resolvedKey = resolveOptionalFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
    });

    if (!resolvedKey.fileKey && !resolvedKey.keyParts) {
      throw new Error("Missing file key. Provide --file-key or --key-parts.");
    }

    const stats = await fs.stat(filePath);
    const sizeBytes = stats.size;
    const filename = (ctx.values["filename"] as string | undefined) ?? path.basename(filePath);
    const contentType = (ctx.values["content-type"] as string | undefined) ?? DEFAULT_CONTENT_TYPE;

    const checksum = parseJsonValue("checksum", ctx.values["checksum"] as string | undefined);
    const tags = parseJsonValue("tags", ctx.values["tags"] as string | undefined);
    const metadata = parseJsonValue("metadata", ctx.values["metadata"] as string | undefined);

    const client = createClientFromContext(ctx);
    const upload = (await client.createUpload({
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
    })) as {
      uploadId: string;
      strategy: "direct-single" | "direct-multipart" | "proxy";
      upload: {
        partSizeBytes?: number;
        maxParts?: number;
        uploadUrl?: string;
        uploadHeaders?: Record<string, string>;
      };
    };

    if (upload.strategy === "direct-single") {
      if (!upload.upload.uploadUrl) {
        throw new Error("Missing upload URL for direct upload");
      }

      const headers = new Headers(upload.upload.uploadHeaders ?? {});
      headers.set("Content-Length", String(sizeBytes));
      const init: RequestInit & { duplex?: "half" } = {
        method: "PUT",
        headers,
        body: Readable.toWeb(createReadStream(filePath)) as BodyInit,
        duplex: "half",
      };
      const response = await fetch(upload.upload.uploadUrl, init);

      if (!response.ok) {
        throw new Error(`Direct upload failed (${response.status})`);
      }

      await client.reportProgress(upload.uploadId, {
        bytesUploaded: sizeBytes,
        partsUploaded: 1,
      });

      const file = await client.completeUpload(upload.uploadId, []);
      console.log(JSON.stringify({ upload, file }, null, 2));
      return;
    }

    if (upload.strategy === "direct-multipart") {
      const partSizeBytes = upload.upload.partSizeBytes;
      if (!partSizeBytes) {
        throw new Error("Missing multipart part size from server");
      }

      const totalParts = Math.ceil(sizeBytes / partSizeBytes);
      if (upload.upload.maxParts && totalParts > upload.upload.maxParts) {
        throw new Error("Multipart upload exceeds maximum parts");
      }

      const partNumbers = Array.from({ length: totalParts }, (_, index) => index + 1);
      const partUrls = (await client.getPartUrls(upload.uploadId, partNumbers)) as {
        parts: { partNumber: number; url: string; headers?: Record<string, string> }[];
      };
      const orderedParts = partUrls.parts.sort((a, b) => a.partNumber - b.partNumber);

      const completedParts: { partNumber: number; etag: string; sizeBytes: number }[] = [];
      const completionParts: { partNumber: number; etag: string }[] = [];

      let bytesUploaded = 0;
      let partsUploaded = 0;

      for (const part of orderedParts) {
        const start = (part.partNumber - 1) * partSizeBytes;
        const length = Math.min(partSizeBytes, sizeBytes - start);
        const end = start + length - 1;

        const headers = new Headers(part.headers ?? {});
        headers.set("Content-Length", String(length));
        const init: RequestInit & { duplex?: "half" } = {
          method: "PUT",
          headers,
          body: Readable.toWeb(createReadStream(filePath, { start, end })) as BodyInit,
          duplex: "half",
        };

        const response = await fetch(part.url, init);

        if (!response.ok) {
          throw new Error(`Multipart upload failed (${response.status})`);
        }

        const etag = response.headers.get("etag") ?? response.headers.get("ETag");
        if (!etag) {
          throw new Error("Missing ETag for uploaded part");
        }

        completedParts.push({ partNumber: part.partNumber, etag, sizeBytes: length });
        completionParts.push({ partNumber: part.partNumber, etag });

        bytesUploaded += length;
        partsUploaded += 1;
        await client.reportProgress(upload.uploadId, {
          bytesUploaded,
          partsUploaded,
        });
      }

      await client.completeParts(upload.uploadId, completedParts);
      const file = await client.completeUpload(upload.uploadId, completionParts);
      console.log(JSON.stringify({ upload, file }, null, 2));
      return;
    }

    const response = await client.uploadContent(
      upload.uploadId,
      Readable.toWeb(createReadStream(filePath)) as BodyInit,
      contentType,
    );
    console.log(JSON.stringify({ upload, file: response }, null, 2));
  },
});
