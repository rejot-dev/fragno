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
import type { WebExtractInput, WebRuntime } from "./web-runtime";

export type { WebRuntime } from "./web-runtime";

const webPageInputSchema = z
  .looseObject({
    url: z.url().optional(),
    html: z.string().optional(),
  })
  .refine((input) => input.url !== undefined || input.html !== undefined, {
    message: "Web extraction input requires either `url` or `html`.",
  });

const webExtractInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("content"), input: webPageInputSchema }),
  z.object({ action: z.literal("markdown"), input: webPageInputSchema }),
]) as z.ZodType<WebExtractInput>;

const webExtractResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("content"), result: z.string() }),
  z.object({ action: z.literal("markdown"), result: z.string() }),
]);

type WebToolContext = BackofficeToolContext<{ web?: WebRuntime }>;

const getWebRuntime = (runtime: WebToolContext["runtimes"]["web"]): WebRuntime => {
  if (!runtime) {
    throw new Error("Web runtime is not available in this execution context");
  }
  return runtime;
};

const parseExtract = (args: string[]): WebExtractInput => {
  const parsed = parseCliTokens(args);
  const inputJson = readStringOption(parsed, "input-json", true);
  if (!inputJson) {
    throw new Error("Missing required option --input-json");
  }

  return webExtractInputSchema.parse({
    action: readStringOption(parsed, "action", true),
    input: JSON.parse(inputJson) as unknown,
  });
};

const webExtractTool = defineBackofficeRuntimeTool({
  id: "web.extract",
  namespace: "web",
  authorizationNamespace: "cloudflare",
  name: "extract",
  description: "Extract page content or Markdown from a URL or HTML.",
  requiredPermissions: ["browserRun"],
  inputSchema: webExtractInputSchema,
  outputSchema: webExtractResultSchema,
  execute: async (input, context: WebToolContext) =>
    await getWebRuntime(context.runtimes.web).extract(input),
  adapters: {
    bash: {
      command: "web.extract",
      help: {
        summary: "Extract content or Markdown from a page.",
        options: [
          {
            name: "action",
            required: true,
            valueRequired: true,
            valueName: "action",
            description: "content or markdown.",
          },
          {
            name: "input-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Page input JSON containing a URL or HTML and browser options.",
          },
        ],
        examples: [`web.extract --action markdown --input-json '{"url":"https://example.com"}'`],
      },
      parse: parseExtract,
      outputOptions: (args) => {
        const output = readOutputOptions(parseCliTokens(args));
        return output.print ? output : { ...output, format: "json" as const };
      },
      format: (result) => ({ data: result }),
    },
  },
});

export const webRuntimeTools = [webExtractTool] as const;

export const webToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "web",
  permissions: {
    browserRun: "Extract content from web pages.",
  },
  tools: webRuntimeTools,
  isAvailable: (context: WebToolContext) => !!context.runtimes.web,
});
