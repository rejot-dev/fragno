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
