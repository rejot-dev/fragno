// Records an organization's universe from a Leyway server, as its Map opens it for you: the
// organization, its projects, and your personal scope, each with its whole Automations outbox.
// `pnpm --filter @fragno-apps/backoffice-rr universe-replay` replays it; see vite.replay.config.ts.
//
//   pnpm --filter @fragno-apps/backoffice-rr universe-replay:capture org:rejot
//
// It signs in as the Leyway CLI does (`pnpm -w -s leyway login --base-url <server>`) and only
// reads. The recording holds the scopes' real events, so it is kept outside the repository, where
// every worktree replays it; see replay-root.ts.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  backofficeScopeIdCodec,
  formatBackofficeScopeRoutePath,
  type BackofficeContextScope,
  type BackofficeJurisdiction,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { parseOutboxStreamFrame, type OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";

import {
  executeBackofficeCodemode,
  listBackofficeAvailableScopesForServer,
  openBackofficeAutomationsStream,
  parseBackofficeScope,
  type LeywayCliScope,
} from "@rejot-dev/backoffice-local";

import {
  UNIVERSE_REPLAY_MANIFEST_FILE,
  type UniverseReplayManifest,
} from "../../replay/manifest.ts";
import { universeReplayRoot } from "./replay-root.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "base-url": { type: "string", default: "https://leyway.com" } },
});
const baseUrl = values["base-url"];
const organizationArgument = positionals[0];
if (positionals.length !== 1 || !organizationArgument?.startsWith("org:")) {
  throw new Error("Usage: universe-replay:capture org:<organization-slug> [--base-url URL]");
}

type RecordedStream = {
  adapterIdentity: string;
  entries: string[];
  throughVersionstamp: string | null;
};

async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<OutboxStreamFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        yield parseOutboxStreamFrame(JSON.parse(line));
      }
    }
  }
}

/**
 * Reads a scope's outbox from its start until the server reports it caught up with what it held
 * when the stream started, resuming after the last entry when the server rotates the stream.
 */
async function recordStream(scope: LeywayCliScope): Promise<RecordedStream> {
  const entries: string[] = [];
  let adapterIdentity: string | null = null;
  let afterVersionstamp: string | undefined;
  for (;;) {
    // Leaving the loop cancels the response body, which closes the stream.
    const body = await openBackofficeAutomationsStream({ baseUrl, scope, afterVersionstamp });
    for await (const frame of framesOf(body)) {
      if (frame.type === "started") {
        if (adapterIdentity !== null && adapterIdentity !== frame.adapterIdentity) {
          throw new Error(`The backend of ${JSON.stringify(scope)} was replaced while recording.`);
        }
        adapterIdentity = frame.adapterIdentity;
      } else if (frame.type === "entry") {
        entries.push(JSON.stringify(frame.entry));
        afterVersionstamp = frame.entry.versionstamp;
      } else if (frame.type === "caught-up") {
        if (adapterIdentity === null) {
          throw new Error("The stream reported it caught up before it started.");
        }
        return { adapterIdentity, entries, throughVersionstamp: afterVersionstamp ?? null };
      } else if (frame.type === "rotate") {
        break;
      }
    }
  }
}

/** What a codemode program returns in the scope, which only reads. */
async function readInScope(scope: LeywayCliScope, code: string): Promise<unknown> {
  const response = (await executeBackofficeCodemode({ baseUrl, scope, code })) as {
    result: unknown;
  };
  return response.result;
}

const available = await listBackofficeAvailableScopesForServer({ baseUrl });
const organizationScope = available.find((scope) => scope.argument === organizationArgument);
const viewerScope = available.find((scope) => scope.argument.startsWith("user:"));
if (!organizationScope || !viewerScope) {
  throw new Error(
    `${baseUrl} lists no ${organizationArgument} or personal scope for you. Run \`pnpm -w -s leyway scopes --base-url ${baseUrl}\`.`,
  );
}
const orgSlug = organizationArgument.slice("org:".length);
const organization = (await readInScope(
  parseBackofficeScope(organizationArgument),
  // Every page of the directory, as the Map's loader lists it, archived projects left out.
  `async () => {
    const listed = [];
    let cursor = null;
    do {
      const page = await projects.list({ pageSize: 100, cursor });
      listed.push(...page.projects.filter((project) => project.archivedAt === null));
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor !== null);
    return {
      scope: await context.getCurrentScope(),
      projects: listed.map(({ projectId, slug, name }) => ({ projectId, slug, name })),
    };
  }`,
)) as {
  scope: { kind: "org"; orgId: string; jurisdiction: BackofficeJurisdiction | null };
  projects: { projectId: string; slug: string; name: string }[];
};
const viewer = (await readInScope(
  parseBackofficeScope(viewerScope.argument),
  "async () => context.getCurrentScope()",
)) as BackofficeContextScope;
if (viewer.kind !== "user") {
  throw new Error(`${viewerScope.argument} is not a personal scope.`);
}

const scopes: { argument: string; scope: BackofficeContextScope }[] = [
  { argument: organizationArgument, scope: organization.scope },
  ...organization.projects.map((project) => ({
    argument: `project:${organizationArgument}:${project.projectId}`,
    scope: {
      kind: "project" as const,
      owner: organization.scope,
      projectId: project.projectId,
    },
  })),
  { argument: viewerScope.argument, scope: viewer },
];

const directory = path.join(universeReplayRoot(), orgSlug);
await rm(directory, { recursive: true, force: true });
// Only you may read the recorded events.
await mkdir(directory, { recursive: true, mode: 0o700 });

const streams: UniverseReplayManifest["streams"] = {};
const recorded = new Map<string, RecordedStream>();
// One scope at a time, as the server streams each outbox from its own backend.
for (const { argument, scope } of scopes) {
  const stream = await recordStream(parseBackofficeScope(argument));
  const routePath = formatBackofficeScopeRoutePath(scope, backofficeScopeIdCodec);
  const file = `${routePath.replaceAll("/", "__")}.ndjson`;
  await writeFile(path.join(directory, file), stream.entries.map((entry) => `${entry}\n`).join(""));
  streams[routePath] = {
    file,
    adapterIdentity: stream.adapterIdentity,
    throughVersionstamp: stream.throughVersionstamp,
  };
  recorded.set(argument, stream);
  console.error(`${argument}: ${stream.entries.length} outbox entries`);
}

const adapterIdentityOf = (argument: string) => {
  const stream = recorded.get(argument);
  if (!stream) {
    throw new Error(`${argument} was not recorded.`);
  }
  return stream.adapterIdentity;
};
const manifest: UniverseReplayManifest = {
  capturedAt: new Date().toISOString(),
  from: baseUrl,
  organization: {
    id: organization.scope.orgId,
    slug: orgSlug,
    name: organizationScope.label,
    jurisdiction: organization.scope.jurisdiction,
    adapterIdentity: adapterIdentityOf(organizationArgument),
  },
  projects: organization.projects.map((project) => ({
    id: project.projectId,
    slug: project.slug,
    name: project.name,
    adapterIdentity: adapterIdentityOf(`project:${organizationArgument}:${project.projectId}`),
  })),
  viewer: {
    userId: viewer.userId,
    jurisdiction: viewer.jurisdiction,
    label: viewerScope.label,
    adapterIdentity: adapterIdentityOf(viewerScope.argument),
  },
  streams,
};
await writeFile(
  path.join(directory, UNIVERSE_REPLAY_MANIFEST_FILE),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.error(
  `Recorded ${directory}. Run \`pnpm --filter @fragno-apps/backoffice-rr universe-replay\` and open its /replay/${orgSlug}.`,
);
