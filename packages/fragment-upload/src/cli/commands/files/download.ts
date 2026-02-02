import { define } from "gunshi";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { baseArgs, createClientFromContext, resolveFileKeyValue } from "../../utils/options.js";

export const filesDownloadCommand = define({
  name: "download",
  description: "Download file contents",
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
    output: {
      type: "string",
      short: "o",
      description: "Output file path",
    },
    stdout: {
      type: "boolean",
      description: "Write content to stdout",
    },
  },
  run: async (ctx) => {
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
      keyParts: ctx.values["key-parts"] as string | undefined,
    });

    const outputPath = ctx.values["output"] as string | undefined;
    const toStdout = Boolean(ctx.values["stdout"]);

    if (!outputPath && !toStdout) {
      throw new Error("Provide --output or --stdout.");
    }

    const client = createClientFromContext(ctx);

    let response: Response;
    try {
      const download = (await client.getDownloadUrl(resolvedKey.fileKey)) as {
        url: string;
        headers?: Record<string, string>;
      };
      response = await fetch(download.url, {
        method: "GET",
        headers: download.headers,
      });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
    } catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      if (code !== "SIGNED_URL_UNSUPPORTED") {
        throw error;
      }
      response = await client.downloadContent(resolvedKey.fileKey);
    }

    if (!response.body) {
      throw new Error("Response has no body");
    }

    const bodyStream = Readable.fromWeb(response.body as unknown as NodeReadableStream);

    if (toStdout) {
      await pipeline(bodyStream, process.stdout);
      return;
    }

    await pipeline(bodyStream, createWriteStream(outputPath as string));
    console.log(`Downloaded to ${outputPath}`);
  },
});
