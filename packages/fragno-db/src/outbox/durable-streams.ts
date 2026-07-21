import type { OutboxEntry, OutboxPayloadSerialized } from "./outbox";

const OUTBOX_VERSIONSTAMP_HEX_LENGTH = 24;
const STREAM_OFFSET_HEX_LENGTH = OUTBOX_VERSIONSTAMP_HEX_LENGTH + 1;
const STREAM_OFFSET_REGEX = new RegExp(`^[0-9a-f]{${STREAM_OFFSET_HEX_LENGTH}}$`);
const MAX_STREAM_POSITION = 1n << BigInt(OUTBOX_VERSIONSTAMP_HEX_LENGTH * 4);
export const DURABLE_STREAM_ZERO_OFFSET = "0".repeat(STREAM_OFFSET_HEX_LENGTH);

const LONG_POLL_TIMEOUT_MS = 2_000;
const LONG_POLL_INTERVAL_MS = 200;
const READ_PAGE_SIZE = 100;

const STREAM_OFFSET_HEADER = "Stream-Next-Offset";
const STREAM_UP_TO_DATE_HEADER = "Stream-Up-To-Date";
const STREAM_CURSOR_HEADER = "Stream-Cursor";

const CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0);
const CURSOR_INTERVAL_MS = 20_000;

const INVALID_OUTBOX_PAYLOAD_ERROR_CODE = "INVALID_OUTBOX_PAYLOAD";

class InvalidOutboxPayloadError extends Error {
  readonly code = INVALID_OUTBOX_PAYLOAD_ERROR_CODE;

  constructor(entry: OutboxEntry, reason: string) {
    super(`Outbox entry ${entry.versionstamp} has an invalid payload: ${reason}.`);
    this.name = "InvalidOutboxPayloadError";
  }
}

export type DurableStreamSchema = {
  name: string;
  namespace: string | null;
};

type ListOutboxEntries = (options?: {
  afterVersionstamp?: string;
  limit?: number;
}) => Promise<OutboxEntry[]>;

type ParsedOffset =
  | { kind: "beginning" }
  | { kind: "now" }
  | { kind: "versionstamp"; value: string };

type OffsetParseResult = { ok: true; offset: ParsedOffset } | { ok: false; error: Response };
type CursorParseResult = { ok: true; cursor: bigint | undefined } | { ok: false; error: Response };

type OutboxReadPage = {
  entries: OutboxEntry[];
  nextOffset: string;
  upToDate: boolean;
};

function parseCursor(query: URLSearchParams): CursorParseResult {
  const values = query.getAll("cursor");
  if (values.length === 0) {
    return { ok: true, cursor: undefined };
  }
  if (values.length > 1) {
    return {
      ok: false,
      error: durableStreamErrorResponse(400, "Multiple cursor parameters are not allowed."),
    };
  }

  const value = values[0];
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return {
      ok: false,
      error: durableStreamErrorResponse(400, "Cursor must be a canonical non-negative integer."),
    };
  }

  return { ok: true, cursor: BigInt(value) };
}

function generateCursor(previous?: bigint): string {
  const interval = BigInt(Math.floor((Date.now() - CURSOR_EPOCH_MS) / CURSOR_INTERVAL_MS));
  if (previous === undefined || previous < interval) {
    return interval.toString();
  }

  const jitterSeconds = 1 + Math.floor(Math.random() * 3600);
  const jitterIntervals = BigInt(Math.ceil((jitterSeconds * 1000) / CURSOR_INTERVAL_MS));
  return (previous + jitterIntervals).toString();
}

function baseHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Cross-Origin-Resource-Policy")) {
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  if (!headers.has("Access-Control-Expose-Headers")) {
    headers.set(
      "Access-Control-Expose-Headers",
      "ETag, Stream-Cursor, Stream-Next-Offset, Stream-Up-To-Date",
    );
  }
  return headers;
}

export function durableStreamErrorResponse(
  status: number,
  message: string,
  init?: HeadersInit,
): Response {
  const headers = baseHeaders({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...Object.fromEntries(new Headers(init)),
  });
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export function durableStreamMethodNotAllowedResponse(): Response {
  return durableStreamErrorResponse(405, "Method not allowed for this read-only stream.", {
    Allow: "GET, HEAD, OPTIONS",
  });
}

export function durableStreamPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: baseHeaders({
      "Cache-Control": "no-store",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
      "Access-Control-Max-Age": "86400",
    }),
  });
}

function parseOffset(query: URLSearchParams, required: boolean): OffsetParseResult {
  const values = query.getAll("offset");
  if (values.length === 0) {
    return required
      ? { ok: false, error: durableStreamErrorResponse(400, "Offset query parameter is required.") }
      : { ok: true, offset: { kind: "beginning" } };
  }
  if (values.length > 1) {
    return {
      ok: false,
      error: durableStreamErrorResponse(400, "Multiple offset parameters are not allowed."),
    };
  }

  const value = values[0];
  if (!value) {
    return {
      ok: false,
      error: durableStreamErrorResponse(400, "Offset parameter cannot be empty."),
    };
  }
  if (value === "-1") {
    return { ok: true, offset: { kind: "beginning" } };
  }
  if (value === "now") {
    return { ok: true, offset: { kind: "now" } };
  }
  if (!STREAM_OFFSET_REGEX.test(value)) {
    return {
      ok: false,
      error: durableStreamErrorResponse(
        400,
        `Offset must be a ${STREAM_OFFSET_HEX_LENGTH}-character lowercase hexadecimal token.`,
      ),
    };
  }
  if (BigInt(`0x${value}`) > MAX_STREAM_POSITION) {
    return {
      ok: false,
      error: durableStreamErrorResponse(400, "Offset is outside the supported stream range."),
    };
  }

  return { ok: true, offset: { kind: "versionstamp", value } };
}

export function outboxVersionstampToStreamOffset(versionstamp: string): string {
  const nextPosition = BigInt(`0x${versionstamp}`) + 1n;
  return nextPosition.toString(16).padStart(STREAM_OFFSET_HEX_LENGTH, "0");
}

export function streamOffsetToAfterVersionstamp(offset: string): string | undefined {
  const position = BigInt(`0x${offset}`);
  if (position === 0n) {
    return undefined;
  }
  return (position - 1n).toString(16).padStart(OUTBOX_VERSIONSTAMP_HEX_LENGTH, "0");
}

type OutboxProjectionMutation = {
  schema: string;
  schemaName?: string;
  namespace: string | null;
};

function parseOutboxProjectionMutations(entry: OutboxEntry): OutboxProjectionMutation[] {
  const payload = entry.payload as OutboxPayloadSerialized | undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidOutboxPayloadError(entry, "payload must be an object");
  }

  const json = payload.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new InvalidOutboxPayloadError(entry, "payload.json must be an object");
  }

  const payloadRecord = json as Record<string, unknown>;
  if (payloadRecord["version"] !== 1) {
    throw new InvalidOutboxPayloadError(entry, "payload.json.version must be 1");
  }

  const mutations = payloadRecord["mutations"];
  if (!Array.isArray(mutations)) {
    throw new InvalidOutboxPayloadError(entry, "payload.json.mutations must be an array");
  }

  return mutations.map((mutation, mutationIndex) => {
    if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
      throw new InvalidOutboxPayloadError(
        entry,
        `payload.json.mutations[${mutationIndex}] must be an object`,
      );
    }

    const mutationRecord = mutation as Record<string, unknown>;
    const physicalSchema = mutationRecord["schema"];
    if (typeof physicalSchema !== "string") {
      throw new InvalidOutboxPayloadError(
        entry,
        `payload.json.mutations[${mutationIndex}].schema must be a string`,
      );
    }

    const logicalSchemaName = mutationRecord["schemaName"];
    if (logicalSchemaName !== undefined && typeof logicalSchemaName !== "string") {
      throw new InvalidOutboxPayloadError(
        entry,
        `payload.json.mutations[${mutationIndex}].schemaName must be a string when present`,
      );
    }

    const namespace = mutationRecord["namespace"];
    if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
      throw new InvalidOutboxPayloadError(
        entry,
        `payload.json.mutations[${mutationIndex}].namespace must be a string or null when present`,
      );
    }

    return {
      schema: physicalSchema,
      ...(logicalSchemaName === undefined ? {} : { schemaName: logicalSchemaName }),
      namespace: namespace ?? null,
    };
  });
}

function projectionMutationMatchesSchema(
  mutation: OutboxProjectionMutation,
  schema: DurableStreamSchema,
): boolean {
  const namespaceMatches = mutation.namespace === schema.namespace;
  const schemaMatches =
    mutation.schemaName === schema.name ||
    (mutation.schemaName === undefined &&
      schema.namespace !== null &&
      mutation.schema === schema.namespace);
  return schemaMatches && namespaceMatches;
}

function payloadMatchesSchema(entry: OutboxEntry, schema: DurableStreamSchema): boolean {
  const mutations = parseOutboxProjectionMutations(entry);
  return mutations.some((mutation) => projectionMutationMatchesSchema(mutation, schema));
}

function filterEntriesBySchema(
  entries: OutboxEntry[],
  schema?: DurableStreamSchema,
): OutboxEntry[] {
  if (!schema) {
    return entries;
  }
  return entries.filter((entry) => payloadMatchesSchema(entry, schema));
}

async function readOutboxPage(options: {
  afterVersionstamp?: string;
  schema?: DurableStreamSchema;
  listOutboxEntries: ListOutboxEntries;
}): Promise<OutboxReadPage> {
  const scannedEntries = await options.listOutboxEntries({
    afterVersionstamp: options.afterVersionstamp
      ? streamOffsetToAfterVersionstamp(options.afterVersionstamp)
      : undefined,
    limit: READ_PAGE_SIZE + 1,
  });
  const upToDate = scannedEntries.length <= READ_PAGE_SIZE;
  const pageEntries = scannedEntries.slice(0, READ_PAGE_SIZE);
  const lastVersionstamp = pageEntries[pageEntries.length - 1]?.versionstamp;
  const nextOffset = lastVersionstamp
    ? outboxVersionstampToStreamOffset(lastVersionstamp)
    : (options.afterVersionstamp ?? DURABLE_STREAM_ZERO_OFFSET);

  return {
    entries: filterEntriesBySchema(pageEntries, options.schema),
    nextOffset,
    upToDate,
  };
}

async function responseEtag(options: {
  schema?: DurableStreamSchema;
  startOffset: string;
  page: OutboxReadPage;
}): Promise<string> {
  const input = JSON.stringify({
    schema: options.schema?.name ?? null,
    namespace: options.schema?.namespace ?? null,
    startOffset: options.startOffset,
    nextOffset: options.page.nextOffset,
    upToDate: options.page.upToDate,
    entryOffsets: options.page.entries.map((entry) => entry.versionstamp),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `"${hex}"`;
}

function ifNoneMatchIncludes(headers: Headers, etag: string): boolean {
  return (headers.get("If-None-Match") ?? "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

async function buildJsonResponse(options: {
  status: 200 | 204;
  page: OutboxReadPage;
  schema?: DurableStreamSchema;
  startOffset: string;
  requestHeaders: Headers;
  cursor?: string;
  includeEtag?: boolean;
  projectEntries?: (entries: readonly OutboxEntry[]) => readonly unknown[];
}): Promise<Response> {
  const headers = baseHeaders({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  headers.set(STREAM_OFFSET_HEADER, options.page.nextOffset);
  if (options.page.upToDate) {
    headers.set(STREAM_UP_TO_DATE_HEADER, "true");
  }
  if (options.cursor) {
    headers.set(STREAM_CURSOR_HEADER, options.cursor);
  }

  if (options.includeEtag) {
    const etag = await responseEtag(options);
    headers.set("ETag", etag);
    if (ifNoneMatchIncludes(options.requestHeaders, etag)) {
      return new Response(null, { status: 304, headers });
    }
  }

  if (options.status === 204) {
    return new Response(null, { status: 204, headers });
  }

  const items = options.projectEntries?.(options.page.entries) ?? options.page.entries;
  return new Response(JSON.stringify(items), { status: 200, headers });
}

function requestAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw requestAbortReason(signal);
  }
}

function waitForPollingInterval(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(requestAbortReason(signal as AbortSignal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, LONG_POLL_INTERVAL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForEntries(options: {
  afterVersionstamp: string;
  schema?: DurableStreamSchema;
  listOutboxEntries: ListOutboxEntries;
  signal?: AbortSignal;
}): Promise<OutboxReadPage> {
  const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
  let scanOffset = options.afterVersionstamp;

  while (true) {
    throwIfAborted(options.signal);
    const page = await readOutboxPage({
      afterVersionstamp: scanOffset,
      schema: options.schema,
      listOutboxEntries: options.listOutboxEntries,
    });
    scanOffset = page.nextOffset;

    if (page.entries.length > 0) {
      return page;
    }
    if (!page.upToDate) {
      continue;
    }
    if (Date.now() >= deadline) {
      return page;
    }

    await waitForPollingInterval(options.signal);
  }
}

export async function handleDurableStreamRequest(options: {
  method: string;
  /** Omit to expose the adapter-wide outbox without schema filtering. */
  schema?: DurableStreamSchema;
  query: URLSearchParams;
  headers?: Headers;
  signal?: AbortSignal;
  listOutboxEntries: ListOutboxEntries;
  getTailOffset: () => Promise<string | undefined>;
  /** Project stored outbox entries into the JSON items exposed by this stream. */
  projectEntries?: (entries: readonly OutboxEntry[]) => readonly unknown[];
}): Promise<Response> {
  try {
    return await executeDurableStreamRequest(options);
  } catch (error) {
    if (error instanceof InvalidOutboxPayloadError) {
      const headers = baseHeaders({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
          },
        }),
        { status: 500, headers },
      );
    }
    throw error;
  }
}

async function executeDurableStreamRequest(options: {
  method: string;
  schema?: DurableStreamSchema;
  query: URLSearchParams;
  headers?: Headers;
  signal?: AbortSignal;
  listOutboxEntries: ListOutboxEntries;
  getTailOffset: () => Promise<string | undefined>;
  projectEntries?: (entries: readonly OutboxEntry[]) => readonly unknown[];
}): Promise<Response> {
  const { method, schema, query, listOutboxEntries } = options;
  const requestHeaders = options.headers ?? new Headers();

  if (method === "HEAD") {
    // Schema projections and the adapter-wide stream share one global outbox watermark.
    const tailVersionstamp = await options.getTailOffset();
    const tailOffset = tailVersionstamp
      ? outboxVersionstampToStreamOffset(tailVersionstamp)
      : DURABLE_STREAM_ZERO_OFFSET;
    const headers = baseHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    headers.set(STREAM_OFFSET_HEADER, tailOffset);
    return new Response(null, { status: 200, headers });
  }

  if (method !== "GET") {
    return durableStreamMethodNotAllowedResponse();
  }

  const liveValues = query.getAll("live");
  if (liveValues.length > 1) {
    return durableStreamErrorResponse(400, "Multiple live parameters are not allowed.");
  }
  const liveMode = liveValues[0] ?? null;
  if (liveMode !== null && liveMode !== "long-poll") {
    return durableStreamErrorResponse(400, `Unsupported live mode: ${liveMode}.`);
  }

  const offsetResult = parseOffset(query, liveMode === "long-poll");
  if (!offsetResult.ok) {
    return offsetResult.error;
  }

  const cursorResult = liveMode === "long-poll" ? parseCursor(query) : undefined;
  if (cursorResult && !cursorResult.ok) {
    return cursorResult.error;
  }

  let startOffset: string;
  if (offsetResult.offset.kind === "now") {
    const tailVersionstamp = await options.getTailOffset();
    startOffset = tailVersionstamp
      ? outboxVersionstampToStreamOffset(tailVersionstamp)
      : DURABLE_STREAM_ZERO_OFFSET;
  } else if (offsetResult.offset.kind === "beginning") {
    startOffset = DURABLE_STREAM_ZERO_OFFSET;
  } else {
    startOffset = offsetResult.offset.value;
  }

  if (liveMode === "long-poll") {
    const page = await waitForEntries({
      afterVersionstamp: startOffset,
      schema,
      listOutboxEntries,
      signal: options.signal,
    });
    const status = page.entries.length > 0 ? 200 : 204;
    return buildJsonResponse({
      status,
      page,
      schema,
      startOffset,
      requestHeaders,
      cursor: generateCursor(cursorResult?.ok ? cursorResult.cursor : undefined),
      includeEtag: offsetResult.offset.kind !== "now",
      projectEntries: options.projectEntries,
    });
  }

  if (offsetResult.offset.kind === "now") {
    return buildJsonResponse({
      status: 200,
      page: { entries: [], nextOffset: startOffset, upToDate: true },
      schema,
      startOffset,
      requestHeaders,
      projectEntries: options.projectEntries,
    });
  }

  const page = await readOutboxPage({
    afterVersionstamp:
      offsetResult.offset.kind === "beginning" ? undefined : offsetResult.offset.value,
    schema,
    listOutboxEntries,
  });
  return buildJsonResponse({
    status: 200,
    page,
    schema,
    startOffset,
    requestHeaders,
    includeEtag: true,
    projectEntries: options.projectEntries,
  });
}
