import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { FragnoInternalDescription } from "@fragno-dev/db/outbox";
import type { OutboxStreamFrame } from "@fragno-dev/db/outbox-stream";

import {
  FIXTURE_BASE_PATH,
  FIXTURE_INFO_PATH,
  type OutboxFixtureInfo,
} from "./src/outbox-fixture.ts";

type OutboxFixture = {
  path: string;
  bytes: number;
  adapterIdentity: string;
  /** Raw NDJSON `entry` lines, kept opaque and sent byte for byte. */
  entries: Array<{ versionstamp: string; line: Buffer }>;
};

const ENTRY_PREFIX = '{"type":"entry","entry":{"versionstamp":"';
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Serves a recorded `/_internal/outbox/stream` response as a Fragno backend below
 * `FIXTURE_BASE_PATH`, as a Node request handler that passes other requests to `next`. Streams
 * honor `afterVersionstamp`, so a reloaded replica resumes, and stay open after `caught-up` like a
 * live backend, because the client treats a closed stream as an error.
 */
export function createOutboxFixtureHandler(
  path: string,
  log: (message: string) => void,
): (request: IncomingMessage, response: ServerResponse, next: () => void) => void {
  const loadStartedAt = performance.now();
  const fixture = loadOutboxFixture(path);
  log(
    `Loaded ${fixture.entries.length} outbox entries (${(fixture.bytes / 1e6).toFixed(1)} MB) from ${path} in ${Math.round(performance.now() - loadStartedAt)} ms`,
  );
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === `${FIXTURE_BASE_PATH}/_internal`) {
      sendJson(response, describeFixture(fixture));
    } else if (url.pathname === `${FIXTURE_BASE_PATH}/_internal/outbox/stream`) {
      void streamFixture(fixture, url.searchParams.get("afterVersionstamp"), request, response);
    } else if (url.pathname === FIXTURE_INFO_PATH) {
      sendJson(response, {
        path: fixture.path,
        bytes: fixture.bytes,
        versionstamps: fixture.entries.map(({ versionstamp }) => versionstamp),
      } satisfies OutboxFixtureInfo);
    } else {
      next();
    }
  };
}

/** The fixture is a stream recording: one `started` frame followed by `entry` frames. */
function loadOutboxFixture(path: string): OutboxFixture {
  const file = readFileSync(path);
  const lines: Buffer[] = [];
  for (let start = 0; start < file.length; ) {
    const newline = file.indexOf(10, start);
    const end = newline === -1 ? file.length : newline;
    if (end > start) {
      lines.push(file.subarray(start, end));
    }
    start = end + 1;
  }

  const [startedLine, ...entryLines] = lines;
  const started = startedLine ? (JSON.parse(startedLine.toString("utf8")) as unknown) : undefined;
  if (!isStartedFrame(started)) {
    throw new Error(`${path} must start with a "started" outbox stream frame.`);
  }

  const entries = entryLines.map((line, index) => {
    const prefix = line.subarray(0, ENTRY_PREFIX.length + 24).toString("utf8");
    const versionstamp = prefix.slice(ENTRY_PREFIX.length);
    if (!prefix.startsWith(ENTRY_PREFIX) || !/^[0-9a-f]{24}$/u.test(versionstamp)) {
      throw new Error(`${path}:${index + 2} is not an outbox stream entry frame.`);
    }
    return { versionstamp, line };
  });
  for (let index = 1; index < entries.length; index++) {
    if (entries[index].versionstamp <= entries[index - 1].versionstamp) {
      throw new Error(`${path}:${index + 2} is out of versionstamp order.`);
    }
  }

  return { path, bytes: file.length, adapterIdentity: started.adapterIdentity, entries };
}

function isStartedFrame(value: unknown): value is Extract<OutboxStreamFrame, { type: "started" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "started" &&
    "adapterIdentity" in value &&
    typeof value.adapterIdentity === "string"
  );
}

function describeFixture(fixture: OutboxFixture): FragnoInternalDescription {
  return {
    adapterIdentity: fixture.adapterIdentity,
    currentVersionstamp: fixture.entries.at(-1)?.versionstamp ?? null,
    fragments: [],
    schemas: [],
    routes: {
      internal: "/_internal",
      outbox: "/_internal/outbox",
      outboxStream: "/_internal/outbox/stream",
    },
  };
}

async function streamFixture(
  fixture: OutboxFixture,
  afterVersionstamp: string | null,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const closed = new AbortController();
  response.on("close", () => {
    closed.abort();
  });
  const lastVersionstamp = fixture.entries.at(-1)?.versionstamp ?? null;
  const writeFrame = async (frame: OutboxStreamFrame | Buffer) => {
    response.write(frame instanceof Buffer ? frame : JSON.stringify(frame));
    if (!response.write("\n")) {
      // Waiting for the client keeps the replay paced by how fast the page applies entries.
      await once(response, "drain", { signal: closed.signal });
    }
  };

  response.setHeader("Content-Type", "application/x-ndjson");
  response.setHeader("Cache-Control", "no-store");
  try {
    await writeFrame({
      type: "started",
      protocolVersion: 1,
      adapterIdentity: fixture.adapterIdentity,
      catchUpTargetVersionstamp: lastVersionstamp,
      catchUpPageSize: 50,
    });
    for (const entry of fixture.entries) {
      if (closed.signal.aborted) {
        return;
      }
      if (afterVersionstamp === null || entry.versionstamp > afterVersionstamp) {
        await writeFrame(entry.line);
      }
    }
    await writeFrame({ type: "caught-up", throughVersionstamp: lastVersionstamp });
  } catch (error) {
    if (closed.signal.aborted) {
      return;
    }
    throw error;
  }

  const heartbeat = setInterval(() => {
    void writeFrame({ type: "heartbeat" }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  request.on("close", () => {
    clearInterval(heartbeat);
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}
