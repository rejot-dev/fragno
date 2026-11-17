import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

import { FRAGNO_OUTBOX_PAGE_SIZE, type FragnoInternalDescription } from "@fragno-dev/db/outbox";
import type { OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";
import type { Plugin } from "vite";

import {
  UNIVERSE_REPLAY_MANIFEST_FILE,
  UNIVERSE_REPLAY_MANIFESTS_PATH,
  type UniverseReplayManifest,
} from "../../replay/manifest.ts";
import { universeReplayRoot } from "./replay-root.ts";

const AUTOMATIONS_PREFIX = "/api/automations-scoped/";
// Below the client's 15 s idle timeout, which would otherwise reopen the stream.
const HEARTBEAT_MS = 5_000;
// Entries are recorded as `JSON.stringify(entry)`, which writes the versionstamp first.
const VERSIONSTAMP_PREFIX = '{"versionstamp":"';

type Recording = { manifest: UniverseReplayManifest; directory: string };
type RecordedStream = UniverseReplayManifest["streams"][string] & { directory: string };
// Each organization's replay has an origin of its own, `<slug>.localhost`: a scope's requests do
// not say which recording they replay, and two recordings of one scope, such as of the person who
// recorded both, must not share the replica the browser keeps for it.
const RECORDING_HOST = /^([^.:]+)\.localhost(?::\d+)?$/;

// Read on every request, so a new capture is replayed without restarting the server.
async function recordings(): Promise<Recording[]> {
  const root = universeReplayRoot();
  if (!existsSync(root)) {
    return [];
  }
  const found: Recording[] = [];
  for (const organization of await readdir(root)) {
    const directory = path.join(root, organization);
    const manifestFile = path.join(directory, UNIVERSE_REPLAY_MANIFEST_FILE);
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as UniverseReplayManifest;
      found.push({ manifest, directory });
    }
  }
  return found;
}

/** The stream of the scope at `routePath` in the recording the request's origin replays. */
async function recordedStream(
  request: IncomingMessage,
  routePath: string,
): Promise<RecordedStream | undefined> {
  const slug = RECORDING_HOST.exec(request.headers.host ?? "")?.[1];
  const recording = (await recordings()).find(
    ({ manifest }) => manifest.organization.slug === slug,
  );
  const stream = recording?.manifest.streams[routePath];
  return recording && stream ? { ...stream, directory: recording.directory } : undefined;
}

/** The recorded entries after the cursor `after`, null for all of them, each as its JSON line. */
async function* entriesAfter(stream: RecordedStream, after: string | null): AsyncGenerator<string> {
  const lines = createInterface({
    input: createReadStream(path.join(stream.directory, stream.file)),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const versionstamp = line.startsWith(VERSIONSTAMP_PREFIX)
        ? line.slice(VERSIONSTAMP_PREFIX.length, line.indexOf('"', VERSIONSTAMP_PREFIX.length))
        : (JSON.parse(line) as { versionstamp: string }).versionstamp;
      if (after === null || versionstamp > after) {
        yield line;
      }
    }
  } finally {
    lines.close();
  }
}

/**
 * Serves a page of a recorded outbox as its backend does to replicas that poll: up to `limit`
 * entries after the cursor, as a JSON array.
 */
async function pageRecording(
  response: ServerResponse,
  stream: RecordedStream,
  query: URLSearchParams,
) {
  const limit = Number(query.get("limit") ?? FRAGNO_OUTBOX_PAGE_SIZE);
  const page: string[] = [];
  for await (const line of entriesAfter(stream, query.get("afterVersionstamp"))) {
    page.push(line);
    if (page.length >= limit) {
      break;
    }
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`[${page.join(",")}]`);
}

function writeFrame(response: ServerResponse, frame: OutboxStreamFrame): boolean {
  return response.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Serves a recorded outbox as its backend streams one: the entries after the replica's cursor,
 * that it caught up, then heartbeats, as a backend nothing writes to.
 */
async function streamRecording(
  request: IncomingMessage,
  response: ServerResponse,
  stream: RecordedStream,
  query: URLSearchParams,
) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
  });
  writeFrame(response, {
    type: "started",
    protocolVersion: 1,
    adapterIdentity: stream.adapterIdentity,
    catchUpTargetVersionstamp: stream.throughVersionstamp,
    catchUpPageSize: Number(query.get("limit") ?? 500),
  });
  const closed = new Promise<void>((resolve) => {
    request.once("close", resolve);
  });
  for await (const line of entriesAfter(stream, query.get("afterVersionstamp"))) {
    if (request.destroyed) {
      return;
    }
    // The line is the entry's JSON, so it is framed without parsing it.
    if (!response.write(`{"type":"entry","entry":${line}}\n`)) {
      await Promise.race([
        new Promise((resolve) => {
          response.once("drain", resolve);
        }),
        closed,
      ]);
    }
  }
  writeFrame(response, { type: "caught-up", throughVersionstamp: stream.throughVersionstamp });
  const heartbeat = setInterval(() => {
    writeFrame(response, { type: "heartbeat" });
  }, HEARTBEAT_MS);
  await closed;
  clearInterval(heartbeat);
}

async function serveReplay(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://replay.local");
  if (url.pathname === UNIVERSE_REPLAY_MANIFESTS_PATH) {
    const manifests = (await recordings()).map(({ manifest }) => manifest);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(manifests));
    return true;
  }
  if (!url.pathname.startsWith(AUTOMATIONS_PREFIX)) {
    return false;
  }
  const scopedPath = decodeURIComponent(url.pathname.slice(AUTOMATIONS_PREFIX.length));
  const [routePath, internalPath] = scopedPath.split("/_internal");
  const stream = routePath === undefined ? undefined : await recordedStream(request, routePath);
  if (!stream) {
    return false;
  }
  if (internalPath === "") {
    const description: FragnoInternalDescription = {
      adapterIdentity: stream.adapterIdentity,
      currentVersionstamp: stream.throughVersionstamp,
      fragments: [],
      schemas: [],
      routes: {
        internal: "/_internal",
        outbox: "/_internal/outbox",
        outboxStream: "/_internal/outbox/stream",
      },
    };
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(description));
    return true;
  }
  if (internalPath === "/outbox/stream") {
    await streamRecording(request, response, stream, url.searchParams);
    return true;
  }
  if (internalPath === "/outbox") {
    await pageRecording(response, stream, url.searchParams);
    return true;
  }
  return false;
}

/**
 * Replays the organizations `universe-replay:capture` recorded: their manifests for the replay
 * page, and, at each organization's own origin, each recorded scope's Automations backend at the
 * paths Backoffice would serve it, so the scopes' replicas download the recording.
 */
export function universeReplayPlugin(): Plugin {
  return {
    name: "universe-replay",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        serveReplay(request, response).then(
          (served) => {
            if (!served) {
              next();
            }
          },
          (error: unknown) => {
            next(error);
          },
        );
      });
    },
  };
}
