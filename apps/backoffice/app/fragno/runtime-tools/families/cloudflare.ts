import {
  browserRunCaptureInputSchema,
  browserRunCrawlActionInputSchema,
  browserRunCrawlActionResultSchema,
  type BrowserRunCaptureInput,
  type BrowserRunCrawlActionInput,
} from "@fragno-dev/cloudflare-fragment/browser-run";
import { z } from "zod";

import {
  parseCliTokens,
  readOutputOptions,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { CloudflareRuntime } from "./cloudflare-runtime";

export type { CloudflareRuntime } from "./cloudflare-runtime";

type CloudflareToolContext = BackofficeToolContext<{ cloudflare?: CloudflareRuntime }>;

const browserRunCaptureResultSchema = z.object({
  contentType: z.string(),
  data: z.string(),
});

const getCloudflareRuntime = (
  runtime: CloudflareToolContext["runtimes"]["cloudflare"],
): CloudflareRuntime => {
  if (!runtime) {
    throw new Error("Cloudflare runtime is not available in this execution context");
  }
  return runtime;
};

const parseJsonOption = (args: string[]) => {
  const inputJson = readStringOption(parseCliTokens(args), "input-json", true);
  if (!inputJson) {
    throw new Error("Missing required option --input-json");
  }
  return JSON.parse(inputJson) as unknown;
};

const parseCapture = (args: string[]): BrowserRunCaptureInput =>
  browserRunCaptureInputSchema.parse({
    action: readStringOption(parseCliTokens(args), "action", true),
    input: parseJsonOption(args),
  });

const parseCrawl = (args: string[]): BrowserRunCrawlActionInput => {
  const parsed = parseCliTokens(args);
  const action = readStringOption(parsed, "action", true);
  const jobId = readStringOption(parsed, "job-id");
  const inputJson = readStringOption(parsed, "input-json");

  return browserRunCrawlActionInputSchema.parse({
    action,
    ...(jobId ? { jobId } : {}),
    ...(inputJson ? { input: JSON.parse(inputJson) as unknown } : {}),
  });
};

const responseToBase64Result = async (response: Response) => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    data: btoa(binary),
  };
};

const bytesToBinaryString = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
};

const jsonOutputOptions = (args: string[]) => {
  const output = readOutputOptions(parseCliTokens(args));
  return output.print ? output : { ...output, format: "json" as const };
};

const browserRunCaptureTool = defineBackofficeRuntimeTool({
  id: "cloudflare.browser-run.capture",
  namespace: "cloudflare",
  name: "browserRunCapture",
  description: "Capture a page as a PDF or screenshot with Cloudflare Browser Run.",
  requiredPermissions: ["browserRun"],
  inputSchema: browserRunCaptureInputSchema,
  outputSchema: browserRunCaptureResultSchema,
  execute: async (input, context: CloudflareToolContext) =>
    await responseToBase64Result(
      await getCloudflareRuntime(context.runtimes.cloudflare).browserRunCapture(input),
    ),
  adapters: {
    bash: {
      command: "cloudflare.browser-run.capture",
      help: {
        summary: "Capture a page and emit the PDF or image bytes to stdout.",
        options: [
          {
            name: "action",
            required: true,
            valueRequired: true,
            valueName: "action",
            description: "pdf or screenshot.",
          },
          {
            name: "input-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Browser Run page input JSON.",
          },
          {
            name: "output",
            valueRequired: true,
            valueName: "path",
            description: "Write the capture directly to a file instead of stdout.",
          },
        ],
        examples: [
          `cloudflare.browser-run.capture --action screenshot --input-json '{"url":"https://example.com"}' > /tmp/page.png`,
          `cloudflare.browser-run.capture --action pdf --input-json '{"url":"https://example.com"}' --output /tmp/page.pdf`,
        ],
      },
      parse: parseCapture,
      execute: async ({ input, args, context, shell }) => {
        const cloudflareContext = context;
        const response = await getCloudflareRuntime(
          cloudflareContext.runtimes.cloudflare,
        ).browserRunCapture(input);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const outputPath = readStringOption(parseCliTokens(args), "output");

        if (outputPath) {
          const resolvedPath = shell.fs.resolvePath(shell.cwd, outputPath);
          await shell.fs.writeFile(resolvedPath, bytes);
          return { stdout: `Captured ${bytes.byteLength} bytes to ${resolvedPath}\n` };
        }

        return {
          stdout: bytesToBinaryString(bytes),
          stdoutEncoding: "binary" as const,
        };
      },
    },
  },
});

const browserRunCrawlTool = defineBackofficeRuntimeTool({
  id: "cloudflare.browser-run.crawl",
  namespace: "cloudflare",
  name: "browserRunCrawl",
  description: "Start, inspect, or cancel a Cloudflare Browser Run crawl job.",
  requiredPermissions: ["browserRun"],
  inputSchema: browserRunCrawlActionInputSchema,
  outputSchema: browserRunCrawlActionResultSchema,
  execute: async (input, context: CloudflareToolContext) =>
    await getCloudflareRuntime(context.runtimes.cloudflare).browserRunCrawl(input),
  adapters: {
    bash: {
      command: "cloudflare.browser-run.crawl",
      help: {
        summary: "Start, inspect, or cancel a Browser Run crawl job.",
        options: [
          {
            name: "action",
            required: true,
            valueRequired: true,
            valueName: "action",
            description: "start, get, or cancel.",
          },
          {
            name: "input-json",
            valueRequired: true,
            valueName: "json",
            description: "Crawl input JSON for the start action.",
          },
          {
            name: "job-id",
            valueRequired: true,
            valueName: "id",
            description: "Crawl job ID for get and cancel.",
          },
        ],
        examples: [
          `cloudflare.browser-run.crawl --action start --input-json '{"url":"https://example.com"}'`,
          "cloudflare.browser-run.crawl --action get --job-id <job-id>",
        ],
      },
      parse: parseCrawl,
      outputOptions: jsonOutputOptions,
      format: (result) => ({ data: result }),
    },
  },
});

export const cloudflareRuntimeTools = [browserRunCaptureTool, browserRunCrawlTool] as const;

export const cloudflareToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "cloudflare",
  permissions: {
    browserRun: "Run Cloudflare Browser Run actions.",
  },
  tools: cloudflareRuntimeTools,
  isAvailable: (context: CloudflareToolContext) => !!context.runtimes.cloudflare,
});
