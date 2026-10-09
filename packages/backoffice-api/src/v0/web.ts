import { z } from "zod";

import type { BackofficeApiOperation } from "../api";

const webPageInputSchema = z
  .looseObject({
    url: z.url().optional(),
    html: z.string().optional(),
  })
  .refine((input) => input.url !== undefined || input.html !== undefined, {
    message: "Web extraction input requires either `url` or `html`.",
  });

export const webExtractInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("content"), input: webPageInputSchema }),
  z.object({ action: z.literal("markdown"), input: webPageInputSchema }),
]);

const webExtractResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("content"), result: z.string() }),
  z.object({ action: z.literal("markdown"), result: z.string() }),
]);

export const webOperations = {
  "web.extract": {
    description: "Extract page content or Markdown from a URL or HTML.",
    input: webExtractInputSchema,
    output: webExtractResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
