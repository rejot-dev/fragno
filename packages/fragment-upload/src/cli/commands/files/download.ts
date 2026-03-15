import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { define } from "gunshi";

import {
  baseArgs,
  createClientFromContext,
  resolveFileKeyValue,
  resolveProviderValue,
} from "../../utils/options.js";

export const filesDownloadCommand = define({
  name: "download",
  description: "Download file contents",
  args: {
    ...baseArgs,
    provider: {
      type: "string",
      description: "Storage provider",
    },
    "file-key": {
      type: "string",
      description: "File key",
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
    const provider = resolveProviderValue(ctx.values["provider"] as string | undefined);
    const resolvedKey = resolveFileKeyValue({
      fileKey: ctx.values["file-key"] as string | undefined,
    });

    const outputPath = ctx.values["output"] as string | undefined;
    const toStdout = Boolean(ctx.values["stdout"]);

    if (!outputPath && !toStdout) {
      throw new Error("Provide --output or --stdout.");
    }

    const client = createClientFromContext(ctx);

    let response: Response;
    try {
      const download = (await client.getDownloadUrl(provider, resolvedKey.fileKey)) as {
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
      response = await client.downloadContent(provider, resolvedKey.fileKey);
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
