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

const artifactSiteDataStatusOutputSchema = z.lazy(() =>
  z.strictObject({
    status: z
      .enum(["not-started", "catching-up", "caught-up", "failing"])
      .describe(
        "not-started: no site with a worker.js was built or read the data yet. catching-up: the first copy is in progress. caught-up: the copy held everything Automations had. failing: its last attempt to follow Automations failed; it retries at retryAt, and after a day of failures at the next read.",
      ),
    available: z
      .boolean()
      .describe("Whether sites can read the data; until the first catch-up ends they answer 503."),
    following: z
      .boolean()
      .describe(
        "Whether the copy follows changes now. It follows them while sites read, and for a minute after; otherwise the next read finds it as it was, and it catches up then.",
      ),
    progress: z
      .number()
      .nullable()
      .describe("How much of the current catch-up was applied, from 0 to 1, while it runs."),
    lastAppliedAt: z.string().nullable().describe("When the copy last applied a change."),
    lastError: z
      .strictObject({ message: z.string(), at: z.string() })
      .nullable()
      .describe("The copy's last error, kept after it recovers."),
    retryAt: z.string().nullable().describe("When the copy next tries to catch up on its own."),
    sizeBytes: z.number().describe("The size of the copy."),
  }),
);

/** The state of the copy of a scope's automation data that its sites read. */
export type ArtifactSiteDataStatus = z.output<typeof artifactSiteDataStatusOutputSchema>;

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
  "artifacts.sites.dataStatus": {
    description:
      "Report the copy of this scope's automation data that site Workers read with env.DATA.sql. Check it when a site answers 503 or shows old data: it tells whether sites can read the data yet, how far its first copy got, when it last applied a change, its last error, and when it retries.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() => z.strictObject({})),
    output: artifactSiteDataStatusOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
