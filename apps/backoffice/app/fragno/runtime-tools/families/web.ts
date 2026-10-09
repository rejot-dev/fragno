import { webExtractInputSchema } from "@fragno-dev/backoffice-api/v0/web";
import type { z } from "zod";

import {
  parseCliTokens,
  readOutputOptions,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { WebExtractInput, WebRuntime } from "./web-runtime";

export type { WebRuntime } from "./web-runtime";

type WebToolContext = BackofficeToolContext<{ web?: WebRuntime }>;

const getWebRuntime = (runtime: WebToolContext["runtimes"]["web"]): WebRuntime => {
  if (!runtime) {
    throw new Error("Web runtime is not available in this execution context");
  }
  return runtime;
};

const parseExtract = (args: string[]): z.input<typeof webExtractInputSchema> => {
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
  ...backofficeApiOperationToolFields("web.extract"),
  namespace: "web",
  name: "extract",
  // The contract keeps page options open; the Cloudflare fragment validates them in full.
  execute: async (input, context: WebToolContext) =>
    await getWebRuntime(context.runtimes.web).extract(input as WebExtractInput),
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
  tools: webRuntimeTools,
  isAvailable: (context: WebToolContext) => !!context.runtimes.web,
});
