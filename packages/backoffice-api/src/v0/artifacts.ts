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

const siteDirectorySchema = () =>
  z
    .string()
    .trim()
    .regex(/^\/workspace\/.+\.site$/u, "Expected a /workspace/**/<name>.site directory.")
    // A site's path names where its builds are kept, so `..` would name another scope's.
    .refine(
      (path) =>
        path
          .slice("/workspace/".length)
          .split("/")
          .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
      "Expected a normalized path, without empty, . or .. segments.",
    );

export const artifactSiteBuildInputSchema = z.lazy(() =>
  z.strictObject({
    path: siteDirectorySchema(),
  }),
);

// A failed build leaves the site serving its previous build.
const artifactSiteBuildOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("built"),
      path: z.string(),
      url: z
        .string()
        .nullable()
        .describe(
          "Where people open the site: its path at its scope's own subdomain of the sites domain, such as https://quiet-amber-falcon.ley.run/tools/shop.site/. Null where this deployment has no sites domain, so people cannot open its sites.",
        ),
      firesEvents: z
        .boolean()
        .describe(
          "Whether the site's Worker may fire events with env.DATA.fire: true when it has a worker.js and whoever built it may emit events, with events.emit. Building it again as someone else changes it.",
        ),
    }),
    z.strictObject({ status: z.literal("failed"), path: z.string(), message: z.string() }),
  ]),
);

/**
 * What reading a scope's automation data requires, as its own providers require it: a site's
 * Worker reads all of it through env.DATA, and what it reads reaches its answers and logs.
 */
export const ARTIFACT_SITE_DATA_PERMISSIONS = [
  BACKOFFICE_PERMISSION.workflow.read,
  BACKOFFICE_PERMISSION.events.read,
  BACKOFFICE_PERMISSION.router.read,
  BACKOFFICE_PERMISSION.projects.read,
  BACKOFFICE_PERMISSION.store.read,
  BACKOFFICE_PERMISSION.connections.read,
  BACKOFFICE_PERMISSION.pi.read,
] as const;

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

export const artifactSiteLogsInputSchema = z.lazy(() =>
  z.strictObject({
    path: siteDirectorySchema(),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Only requests from this time on, such as when the site was last built."),
    errorsOnly: z
      .boolean()
      .optional()
      .describe("Only requests that threw, exceeded a limit, answered 5xx, or logged an error."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many of the latest requests to return, 50 unless given."),
  }),
);

const artifactSiteLogEntrySchema = z.lazy(() =>
  z.strictObject({
    at: z.string().describe("When the request started."),
    method: z.string().nullable(),
    path: z.string().nullable().describe("The path within the site, with its query."),
    status: z
      .number()
      .nullable()
      .describe("The response's status, or null when the Worker answered none."),
    outcome: z
      .string()
      .describe(
        "ok, exception when the Worker threw, or the limit it exceeded, such as exceededCpu.",
      ),
    cpuMs: z.number().nullable(),
    wallMs: z.number().nullable(),
    logs: z.array(z.strictObject({ level: z.string(), message: z.string() })),
    exceptions: z.array(
      z.strictObject({ name: z.string(), message: z.string(), stack: z.string().nullable() }),
    ),
  }),
);

/** One request a site's Worker handled that logged, threw, exceeded a limit, or answered 5xx. */
export type ArtifactSiteLogEntry = z.output<typeof artifactSiteLogEntrySchema>;

/** The largest request body `artifacts.sites.request` sends. */
export const ARTIFACT_SITE_REQUEST_MAX_BODY_CHARS = 1_000_000;

export const artifactSiteRequestInputSchema = z.lazy(() =>
  z
    .strictObject({
      path: siteDirectorySchema(),
      url: z
        .string()
        .regex(/^\/(?!\/)/u, "Expected a path within the site, such as / or /api/books?page=2.")
        .optional()
        .describe("The path within the site, with its query; / unless given."),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .optional()
        .describe("GET unless given."),
      headers: z
        .record(
          z.string().refine((name) => !name.toLowerCase().startsWith("ley-"), {
            message: "Headers starting with ley- are the host's; set viewer instead.",
          }),
          z.string(),
        )
        .optional(),
      body: z.string().max(ARTIFACT_SITE_REQUEST_MAX_BODY_CHARS).optional(),
      viewer: z
        .strictObject({ id: z.string().min(1), email: z.string() })
        .optional()
        .describe(
          "Who the Worker is told views the site, in ley-viewer-id and ley-viewer-email; nobody unless given.",
        ),
      fire: z
        .boolean()
        .optional()
        .describe(
          "Fire the events the Worker fires, as a viewer's request does, so routes act on them; requires events.emit. Unless true, they are kept in the answer instead.",
        ),
    })
    .refine(
      ({ method, body }) =>
        body === undefined || (method !== undefined && method !== "GET" && method !== "HEAD"),
      { message: "GET and HEAD requests have no body.", path: ["body"] },
    ),
);

export type ArtifactSiteRequestInput = z.output<typeof artifactSiteRequestInputSchema>;

/** How much of a body `artifacts.sites.request` reads, and returns of a text body. */
export const ARTIFACT_SITE_RESPONSE_MAX_TEXT_BYTES = 64 * 1024;

/** How long `artifacts.sites.request` waits for a site's answer and its body. */
export const ARTIFACT_SITE_REQUEST_TIMEOUT_MS = 15_000;

const artifactSiteResponseSchema = z.lazy(() =>
  z.strictObject({
    status: z
      .number()
      .describe(
        "The status a viewer gets: 500 when the Worker threw, and 503 while the scope's data is being copied.",
      ),
    headers: z.record(z.string(), z.string()),
    body: z
      .union([
        z.strictObject({ text: z.string(), truncated: z.boolean() }),
        z.strictObject({
          omitted: z.strictObject({
            type: z.string().nullable(),
            bytes: z
              .number()
              .nullable()
              .describe("Null when the body is over 64 KB and its content-length is not given."),
          }),
        }),
      ])
      .nullable()
      .describe(
        "The body as text, its first 64 KB, when it is text, JSON, HTML, CSS, JavaScript, or SVG; otherwise its type and size. A body is read for at most 15 seconds, so a stream that stays open is cut there, with truncated true. Null when the Worker threw.",
      ),
    bodyError: z
      .string()
      .nullable()
      .describe(
        "Why the body broke off after the status and headers were sent, as a viewer gets it: body holds what arrived before, with truncated true. Null when the body ended, or was cut at its limit.",
      ),
    log: artifactSiteLogEntrySchema
      .nullable()
      .describe(
        "What the Worker logged and threw while answering, with its outcome; null when the runtime had not reported the request within 5 seconds.",
      ),
    events: z
      .array(
        z.strictObject({
          type: z.string(),
          payload: z.record(z.string(), z.unknown()),
          viewer: z.string().nullable(),
          eventId: z
            .string()
            .nullable()
            .describe(
              "The fired event's id, for events.get, when the request set fire; null when the event was kept instead, as env.DATA.fire then returned.",
            ),
        }),
      )
      .describe(
        "The events the Worker fired with env.DATA.fire while answering, in order. Unless the request set fire, they are kept here instead of fired, so no automation acts on them.",
      ),
  }),
);

/** A site's answer to `artifacts.sites.request`, with what its Worker logged and threw. */
export type ArtifactSiteResponse = z.output<typeof artifactSiteResponseSchema>;

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
      "Build a /workspace/**/<name>.site directory and serve the build in place of the previous one. worker.js default-exports { fetch(request, env) } and receives every request; env.ASSETS.fetch(request) answers with the file under public/ at the request's path, with index.html for a path ending in /. A site without worker.js serves its files. worker.js imports saved .js modules by path, not packages, and the Worker reaches no network. Building a site with worker.js also requires reading the scope's automation data: workflow.read, events.read, router.read, projects.read, store.read, connections.read, and pi.read.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, BACKOFFICE_PERMISSION.upload.modify],
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
  "artifacts.sites.logs": {
    description:
      "Read what a site's Worker logged and threw, oldest first, for the latest requests that logged, threw, exceeded a limit, or answered 5xx. Read them after building a site and requesting it, and when a site fails or answers wrongly. Requests are kept for a day, the latest 200 per site.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, ...ARTIFACT_SITE_DATA_PERMISSIONS],
    input: artifactSiteLogsInputSchema,
    output: z.lazy(() => z.strictObject({ entries: z.array(artifactSiteLogEntrySchema) })),
  },
  "artifacts.sites.request": {
    description:
      "Request a built site as a viewer would, and return its answer with what its Worker logged, threw, and fired while answering. A site that does not answer within 15 seconds fails the request. Request the routes a site's pages call and its / after building it, before handing it to the user. The request reaches the site's latest build, reads the scope's data as the site does, and appears in the site's logs like any other.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, ...ARTIFACT_SITE_DATA_PERMISSIONS],
    input: artifactSiteRequestInputSchema,
    output: artifactSiteResponseSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
