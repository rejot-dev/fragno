/** Bounds Deno codemode protocol memory independently of the sandboxed Deno heap limit. */
export const DENO_CODEMODE_PROTOCOL_LIMITS = {
  version: 1,
  maxFrameBytes: 8 * 1024 * 1024,
  maxQueuedWriteBytes: 16 * 1024 * 1024,
  maxActiveHostCalls: 64,
  maxPendingGuestCalls: 64,
  maxRemoteReferences: 512,
  maxWireDepth: 64,
  maxWireValues: 100_000,
  maxCollectionEntries: 10_000,
  maxBinaryBytes: 4 * 1024 * 1024,
} as const;

const DENO_CODEMODE_GUEST_SOURCE = String.raw`
const PROTOCOL_VERSION = ${DENO_CODEMODE_PROTOCOL_LIMITS.version};
const trustedPostMessage = self.postMessage.bind(self);
const trustedJsonStringify = JSON.stringify.bind(JSON);
const trustedJsonParse = JSON.parse.bind(JSON);
const MAX_PENDING_HOST_CALLS = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxActiveHostCalls};
const MAX_REMOTE_REFERENCES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxRemoteReferences};
const MAX_WIRE_DEPTH = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxWireDepth};
const MAX_WIRE_VALUES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxWireValues};
const MAX_COLLECTION_ENTRIES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxCollectionEntries};
const MAX_BINARY_BYTES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxBinaryBytes};
const hostCalls = new Map();
const guestReferences = new Map();
const guestReferenceIds = new WeakMap();
let nextHostCallId = 0;

function send(message) {
  trustedPostMessage(message);
}

function encodeBase64Bytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

function encodeBytes(bytes) {
  if (bytes.byteLength > MAX_BINARY_BYTES) {
    throw new Error("DENO_CODEMODE_RPC_BINARY_LIMIT_EXCEEDED");
  }
  return encodeBase64Bytes(bytes);
}

function decodeBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function registerGuestReference(value, callable) {
  const existingId = guestReferenceIds.get(value);
  if (existingId) return { kind: "remote", id: existingId, callable };
  if (guestReferences.size >= MAX_REMOTE_REFERENCES) {
    throw new Error("DENO_CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED");
  }
  const id = crypto.randomUUID();
  guestReferences.set(id, value);
  guestReferenceIds.set(value, id);
  return { kind: "remote", id, callable };
}

function encodeValue(value, budget = { valueCount: 0 }, ancestors = new Set(), depth = 0) {
  budget.valueCount += 1;
  if (budget.valueCount > MAX_WIRE_VALUES) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_VALUE_LIMIT_EXCEEDED");
  }
  if (depth > MAX_WIRE_DEPTH) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_DEPTH_LIMIT_EXCEEDED");
  }
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return { kind: "null" };
  if (typeof value === "string" || typeof value === "boolean") {
    return { kind: typeof value, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "special-number", value: String(value) };
  }
  if (typeof value === "bigint") return { kind: "bigint", value: String(value) };
  if (typeof value === "function") return registerGuestReference(value, true);
  if (typeof value !== "object") {
    throw new Error("DENO_CODEMODE_RPC_UNSUPPORTED_VALUE:" + typeof value);
  }
  if (value instanceof Date) return { kind: "date", value: value.toISOString() };
  if (value instanceof Uint8Array) return { kind: "bytes", value: encodeBytes(value) };
  if (value instanceof ArrayBuffer) {
    return { kind: "array-buffer", value: encodeBytes(new Uint8Array(value)) };
  }
  if (ancestors.has(value)) throw new Error("DENO_CODEMODE_RPC_CYCLIC_VALUE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return {
        kind: "array",
        value: value.map((entry) => encodeValue(entry, budget, ancestors, depth + 1)),
      };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const keys = Object.keys(value);
      if (keys.length > MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return {
        kind: "object",
        value: Object.fromEntries(
          keys.map((key) => [key, encodeValue(value[key], budget, ancestors, depth + 1)]),
        ),
      };
    }
    return registerGuestReference(value, false);
  } finally {
    ancestors.delete(value);
  }
}

function encodeValues(values) {
  if (values.length > MAX_COLLECTION_ENTRIES) {
    throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
  }
  const budget = { valueCount: 0 };
  const ancestors = new Set();
  return values.map((value) => encodeValue(value, budget, ancestors));
}

function createHostReference(id, callable) {
  const call = (...args) => callHost(id, null, args);
  const target = callable ? call : {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return (...args) => callHost(id, property, args);
    },
    apply(_target, _thisArg, args) {
      return callHost(id, null, args);
    },
  });
}

function decodeValue(value, budget = { valueCount: 0 }, depth = 0) {
  budget.valueCount += 1;
  if (budget.valueCount > MAX_WIRE_VALUES) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_VALUE_LIMIT_EXCEEDED");
  }
  if (depth > MAX_WIRE_DEPTH) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_DEPTH_LIMIT_EXCEEDED");
  }
  switch (value.kind) {
    case "undefined": return undefined;
    case "null": return null;
    case "string":
    case "boolean":
    case "number": return value.value;
    case "special-number": return Number(value.value);
    case "bigint": return BigInt(value.value);
    case "date": return new Date(value.value);
    case "bytes": return decodeBytes(value.value);
    case "array-buffer": {
      const bytes = decodeBytes(value.value);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case "array": {
      if (value.value.length > MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return value.value.map((entry) => decodeValue(entry, budget, depth + 1));
    }
    case "object": {
      const entries = Object.entries(value.value);
      if (entries.length > MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return Object.fromEntries(
        entries.map(([key, entry]) => [key, decodeValue(entry, budget, depth + 1)]),
      );
    }
    case "remote": return createHostReference(value.id, value.callable);
    default: throw new Error("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE");
  }
}

function callHost(referenceId, method, args) {
  if (hostCalls.size >= MAX_PENDING_HOST_CALLS) {
    return Promise.reject(new Error("DENO_CODEMODE_RPC_HOST_CALL_LIMIT_EXCEEDED"));
  }
  let encodedArgs;
  try {
    encodedArgs = encodeValues(args);
  } catch (error) {
    return Promise.reject(error);
  }
  const id = "guest-" + (++nextHostCallId);
  return new Promise((resolve, reject) => {
    hostCalls.set(id, { resolve, reject });
    try {
      send({
        version: PROTOCOL_VERSION,
        type: "callHost",
        id,
        referenceId,
        method,
        args: encodedArgs,
      });
    } catch (error) {
      hostCalls.delete(id);
      reject(error);
    }
  });
}

async function invokeGuestReference(message) {
  const reference = guestReferences.get(message.referenceId);
  if (!reference) throw new Error("DENO_CODEMODE_RPC_GUEST_REFERENCE_NOT_FOUND");
  const decodeBudget = { valueCount: 0 };
  const args = message.args.map((value) => decodeValue(value, decodeBudget));
  if (message.method === null) {
    if (typeof reference !== "function") {
      throw new Error("DENO_CODEMODE_RPC_GUEST_REFERENCE_NOT_CALLABLE");
    }
    return await reference(...args);
  }
  const member = reference[message.method];
  if (typeof member !== "function") {
    throw new Error("DENO_CODEMODE_RPC_GUEST_METHOD_NOT_FOUND:" + message.method);
  }
  return await member.bind(reference)(...args);
}

function moduleSourceUrl(source) {
  const bytes = new TextEncoder().encode(source);
  return "data:text/javascript;base64," + encodeBase64Bytes(bytes);
}

function prepareWorkerSource(source) {
  return source
    .replace(
      /^\s*import\s+\{\s*(?:RpcTarget\s*,\s*)?WorkerEntrypoint\s*\}\s+from\s+["']cloudflare:workers["'];\s*$/gmu,
      "",
    )
    .replace(
      /^\s*import\s+\{\s*AsyncLocalStorage\s*\}\s+from\s+["']node:async_hooks["'];\s*$/gmu,
      "",
    );
}

async function executeStart(message) {
  try {
    const source = message.modules[message.mainModule];
    if (typeof source !== "string") {
      throw new Error("DENO_CODEMODE_MAIN_MODULE_NOT_FOUND:" + message.mainModule);
    }
    const prelude = "import { AsyncLocalStorage } from \"node:async_hooks\";\nclass WorkerEntrypoint {}\nclass RpcTarget {}\n";
    const workerModule = await import(moduleSourceUrl(prelude + prepareWorkerSource(source)));
    if (typeof workerModule.default !== "function") {
      throw new Error("DENO_CODEMODE_ENTRYPOINT_NOT_EXPORTED");
    }
    const entrypoint = new workerModule.default();
    const method = entrypoint[message.method];
    if (typeof method !== "function") {
      throw new Error("DENO_CODEMODE_ENTRYPOINT_METHOD_NOT_FOUND:" + message.method);
    }
    const decodeBudget = { valueCount: 0 };
    const result = await method.bind(entrypoint)(
      ...message.args.map((value) => decodeValue(value, decodeBudget)),
    );
    send({
      version: PROTOCOL_VERSION,
      type: "complete",
      ok: true,
      value: encodeValue(result),
    });
  } catch (error) {
    send({
      version: PROTOCOL_VERSION,
      type: "complete",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.version !== PROTOCOL_VERSION) return;
  if (message.type === "start") {
    void executeStart(message);
    return;
  }
  if (message.type === "hostResult") {
    const pending = hostCalls.get(message.id);
    if (!pending) return;
    hostCalls.delete(message.id);
    if (message.ok) pending.resolve(decodeValue(message.value));
    else pending.reject(new Error(message.error));
    return;
  }
  if (message.type === "callGuest") {
    void (async () => {
      try {
        const value = await invokeGuestReference(message);
        send({
          version: PROTOCOL_VERSION,
          type: "guestResult",
          id: message.id,
          ok: true,
          value: encodeValue(value),
        });
      } catch (error) {
        send({
          version: PROTOCOL_VERSION,
          type: "guestResult",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
});
`;

/** Trusted Deno subprocess bridge; the untrusted bundle runs in a separate Web Worker. */
export const DENO_CODEMODE_RUNNER_SOURCE = String.raw`
const PROTOCOL_VERSION = ${DENO_CODEMODE_PROTOCOL_LIMITS.version};
const trustedJsonParse = JSON.parse.bind(JSON);
const trustedJsonStringify = JSON.stringify.bind(JSON);
const trustedWrite = Deno.stdout.write.bind(Deno.stdout);
const encoder = new TextEncoder();
const MAX_FRAME_BYTES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxFrameBytes};
const MAX_QUEUED_WRITE_BYTES = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxQueuedWriteBytes};
const workerSource = ${JSON.stringify(DENO_CODEMODE_GUEST_SOURCE)};
const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
const worker = new Worker(workerUrl, {
  type: "module",
  deno: { permissions: "none" },
});
URL.revokeObjectURL(workerUrl);
let token = null;
let inputBuffer = "";
let queuedWriteBytes = 0;
let writeQueue = Promise.resolve();

async function writeAll(bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await trustedWrite(bytes.subarray(offset));
  }
}

function send(message) {
  if (token === null) return Promise.resolve();
  const frame = encoder.encode(trustedJsonStringify({ ...message, token }) + "\n");
  if (frame.byteLength > MAX_FRAME_BYTES) {
    return Promise.reject(new Error("DENO_CODEMODE_RPC_FRAME_TOO_LARGE"));
  }
  if (queuedWriteBytes + frame.byteLength > MAX_QUEUED_WRITE_BYTES) {
    return Promise.reject(new Error("DENO_CODEMODE_RPC_WRITE_QUEUE_LIMIT_EXCEEDED"));
  }
  queuedWriteBytes += frame.byteLength;
  const queuedWrite = writeQueue.then(() => writeAll(frame));
  writeQueue = queuedWrite.finally(() => {
    queuedWriteBytes -= frame.byteLength;
  });
  return writeQueue;
}

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.version !== PROTOCOL_VERSION) return;
  void send(message).then(
    () => {
      if (message.type === "complete") Deno.exit(0);
    },
    () => Deno.exit(1),
  );
});
worker.addEventListener("error", (event) => {
  void send({
    version: PROTOCOL_VERSION,
    type: "complete",
    ok: false,
    error: event.message || "DENO_CODEMODE_WORKER_FAILED",
  }).then(() => Deno.exit(1));
});

function acceptMessage(message) {
  if (!message || message.version !== PROTOCOL_VERSION || typeof message.token !== "string") return;
  if (token === null) {
    if (message.type !== "start") return;
    token = message.token;
  }
  if (message.token !== token) return;
  const { token: _token, ...workerMessage } = message;
  worker.postMessage(workerMessage);
}

for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf("\n", offset);
    const segment = newline < 0 ? chunk.slice(offset) : chunk.slice(offset, newline);
    if (inputBuffer.length + segment.length + (newline < 0 ? 0 : 1) > MAX_FRAME_BYTES) {
      await send({
        version: PROTOCOL_VERSION,
        type: "complete",
        ok: false,
        error: "DENO_CODEMODE_RPC_FRAME_TOO_LARGE",
      });
      Deno.exit(1);
    }
    inputBuffer += segment;
    if (newline < 0) break;
    const line = inputBuffer;
    inputBuffer = "";
    try {
      acceptMessage(trustedJsonParse(line));
    } catch (error) {
      await send({
        version: PROTOCOL_VERSION,
        type: "complete",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      Deno.exit(1);
    }
    offset = newline + 1;
  }
}
`;
