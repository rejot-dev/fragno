import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const artifactPageBuildInputSchema = z.lazy(() =>
  z.strictObject({
    path: z
      .string()
      .trim()
      .regex(/^\/workspace\/.+\.page\.js$/u, "Expected a /workspace/**/<name>.page.js path."),
  }),
);

// A failed build is the page's own error, the one people see when they open it.
const artifactPageBuildOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("built"), path: z.string() }),
    z.strictObject({ status: z.literal("failed"), path: z.string(), message: z.string() }),
  ]),
);

export const artifactsOperations = {
  "artifacts.pages.build": {
    description:
      "Build a /workspace/**/<name>.page.js page as Backoffice does when it is opened, without providers, and report its error. The build is cached for viewers.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: artifactPageBuildInputSchema,
    output: artifactPageBuildOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
