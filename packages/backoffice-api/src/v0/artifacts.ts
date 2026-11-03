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

export const artifactSiteBuildInputSchema = z.lazy(() =>
  z.strictObject({
    path: z
      .string()
      .trim()
      .regex(/^\/workspace\/.+\.site$/u, "Expected a /workspace/**/<name>.site directory."),
  }),
);

// A failed build leaves the site serving its previous build.
const artifactSiteBuildOutputSchema = z.lazy(() =>
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
  "artifacts.sites.build": {
    description:
      "Build a /workspace/**/<name>.site directory and serve the build in place of the previous one. worker.js default-exports { fetch(request, env) } and receives every request; env.ASSETS.fetch(request) answers with the file under public/ at the request's path, with index.html for a path ending in /. A site without worker.js serves its files. worker.js imports saved .js modules by path, not packages, and the Worker reaches no network.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: artifactSiteBuildInputSchema,
    output: artifactSiteBuildOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
