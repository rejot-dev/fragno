import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { STATE_FILE_MAX_BYTES } from "./state";

const webPageInputSchema = z.lazy(() =>
  z
    .looseObject({
      url: z.url().optional(),
      html: z.string().optional(),
    })
    .refine((input) => input.url !== undefined || input.html !== undefined, {
      message: "Web extraction input requires either `url` or `html`.",
    }),
);

export const webExtractInputSchema = z.lazy(() =>
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("content"), input: webPageInputSchema }),
    z.object({ action: z.literal("markdown"), input: webPageInputSchema }),
  ]),
);

const webExtractResultSchema = z.lazy(() =>
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("content"), result: z.string() }),
    z.object({ action: z.literal("markdown"), result: z.string() }),
  ]),
);

const webSearchInputSchema = z.lazy(() =>
  z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .describe("What to search for, such as `Acme API authentication`."),
  }),
);

const webSearchOutputSchema = z.lazy(() =>
  z.object({
    results: z
      .array(
        z.object({
          url: z.string(),
          title: z.string(),
          description: z
            .string()
            .nullable()
            .describe("A summary or excerpt of the page; null when the engine wrote none."),
        }),
      )
      .describe("The most relevant pages first."),
  }),
);

const webDownloadInputSchema = z.lazy(() =>
  z.strictObject({
    url: z
      .url({ protocol: /^https$/u, normalize: true })
      .describe(
        "The https URL of the file, such as a temporary download link an integration returns.",
      ),
    path: z
      .string()
      .describe(
        "Absolute path of the file to write under /workspace; an existing file is replaced.",
      ),
  }),
);

const webDownloadOutputSchema = z.lazy(() =>
  z.object({
    path: z.string().describe("Where the file was written."),
    sizeBytes: z.number().int().nonnegative(),
  }),
);

export const webOperations = {
  "web.extract": {
    description: "Extract page content or Markdown from a URL or HTML.",
    permissions: [BACKOFFICE_PERMISSION.cloudflare.browserRun],
    input: webExtractInputSchema,
    output: webExtractResultSchema,
  },
  "web.search": {
    description:
      "Search the web for up to 10 pages, each with its URL, title, and description. Each search " +
      "is billed to the scope's owner and counts toward its ai.cost.total limit.",
    permissions: [BACKOFFICE_PERMISSION.web.search],
    input: webSearchInputSchema,
    output: webSearchOutputSchema,
  },
  "web.download": {
    description:
      "Download a file from a public https URL into the workspace. The request carries no " +
      "credentials, follows up to 5 redirects, and stops after 30 seconds; hosts given as an IP " +
      `address or localhost are refused, and so is a file above ${STATE_FILE_MAX_BYTES} bytes, the most a workspace file holds.`,
    permissions: [BACKOFFICE_PERMISSION.web.download, BACKOFFICE_PERMISSION.upload.modify],
    input: webDownloadInputSchema,
    output: webDownloadOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
