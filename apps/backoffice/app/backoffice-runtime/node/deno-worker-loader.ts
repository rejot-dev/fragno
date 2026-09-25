import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DENO_CODEMODE_PROTOCOL_LIMITS,
  DENO_CODEMODE_RUNNER_SOURCE,
} from "./deno-codemode-runner-source";

const DENO_CODEMODE_PROTOCOL_VERSION = DENO_CODEMODE_PROTOCOL_LIMITS.version;
const DENO_CODEMODE_HARD_TIMEOUT_MS = 125_000;
const DENO_CODEMODE_STDERR_LIMIT = 32_768;
const DENO_CODEMODE_MAX_FRAME_BYTES = DENO_CODEMODE_PROTOCOL_LIMITS.maxFrameBytes;
const DENO_CODEMODE_MAX_QUEUED_WRITE_BYTES = DENO_CODEMODE_PROTOCOL_LIMITS.maxQueuedWriteBytes;
const DENO_CODEMODE_MAX_ACTIVE_HOST_CALLS = DENO_CODEMODE_PROTOCOL_LIMITS.maxActiveHostCalls;
const DENO_CODEMODE_MAX_PENDING_GUEST_CALLS = DENO_CODEMODE_PROTOCOL_LIMITS.maxPendingGuestCalls;
const DENO_CODEMODE_MAX_REMOTE_REFERENCES = DENO_CODEMODE_PROTOCOL_LIMITS.maxRemoteReferences;
const DENO_CODEMODE_MAX_WIRE_DEPTH = DENO_CODEMODE_PROTOCOL_LIMITS.maxWireDepth;
const DENO_CODEMODE_MAX_WIRE_VALUES = DENO_CODEMODE_PROTOCOL_LIMITS.maxWireValues;
const DENO_CODEMODE_MAX_COLLECTION_ENTRIES = DENO_CODEMODE_PROTOCOL_LIMITS.maxCollectionEntries;
const DENO_CODEMODE_MAX_BINARY_BYTES = DENO_CODEMODE_PROTOCOL_LIMITS.maxBinaryBytes;
const DENO_CODEMODE_BLOCKED_HOST_METHODS = new Set([
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

type DenoWorkerFactory = () => {
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: Fetcher | null;
};

type DenoWireValue =
  | { kind: "undefined" | "null" }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "special-number" | "bigint" | "date" | "bytes" | "array-buffer"; value: string }
  | { kind: "array"; value: DenoWireValue[] }
  | { kind: "object"; value: Record<string, DenoWireValue> }
  | { kind: "remote"; id: string; callable: boolean };

type DenoWorkerMessage =
  | {
      version: 1;
      token: string;
      type: "callHost";
      id: string;
      referenceId: string;
      method: string | null;
      args: DenoWireValue[];
    }
  | {
      version: 1;
      token: string;
      type: "guestResult";
      id: string;
      ok: true;
      value: DenoWireValue;
    }
  | {
      version: 1;
      token: string;
      type: "guestResult";
      id: string;
      ok: false;
      error: string;
    }
  | {
      version: 1;
      token: string;
      type: "complete";
      ok: true;
      value: DenoWireValue;
    }
  | {
      version: 1;
      token: string;
      type: "complete";
      ok: false;
      error: string;
    };

type PendingDenoCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type DenoWireValueBudget = {
  valueCount: number;
};

type DenoWireEncodingContext = {
  references: Map<string, WeakKey>;
  referenceIds: WeakMap<WeakKey, string>;
  budget: DenoWireValueBudget;
  ancestors: Set<object>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseDenoWireValue(value: unknown, budget: DenoWireValueBudget, depth = 0): DenoWireValue {
  budget.valueCount += 1;
  if (budget.valueCount > DENO_CODEMODE_MAX_WIRE_VALUES) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_VALUE_LIMIT_EXCEEDED");
  }
  if (depth > DENO_CODEMODE_MAX_WIRE_DEPTH) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_DEPTH_LIMIT_EXCEEDED");
  }
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE");
  }
  switch (value.kind) {
    case "undefined":
    case "null":
      return { kind: value.kind };
    case "string":
      if (typeof value.value === "string") {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "boolean":
      if (typeof value.value === "boolean") {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "number":
      if (typeof value.value === "number") {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "special-number":
    case "date":
      if (typeof value.value === "string") {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "bigint":
      if (typeof value.value === "string" && /^-?\d+$/u.test(value.value)) {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "bytes":
    case "array-buffer":
      if (
        typeof value.value === "string" &&
        value.value.length <= Math.ceil((DENO_CODEMODE_MAX_BINARY_BYTES * 4) / 3) + 2
      ) {
        return { kind: value.kind, value: value.value };
      }
      break;
    case "array":
      if (
        Array.isArray(value.value) &&
        value.value.length <= DENO_CODEMODE_MAX_COLLECTION_ENTRIES
      ) {
        return {
          kind: "array",
          value: value.value.map((entry) => parseDenoWireValue(entry, budget, depth + 1)),
        };
      }
      break;
    case "object":
      if (isRecord(value.value)) {
        const entries = Object.entries(value.value);
        if (entries.length > DENO_CODEMODE_MAX_COLLECTION_ENTRIES) {
          break;
        }
        return {
          kind: "object",
          value: Object.fromEntries(
            entries.map(([key, entry]) => [key, parseDenoWireValue(entry, budget, depth + 1)]),
          ),
        };
      }
      break;
    case "remote":
      if (typeof value.id === "string" && typeof value.callable === "boolean") {
        return { kind: "remote", id: value.id, callable: value.callable };
      }
      break;
  }
  throw new Error(`DENO_CODEMODE_RPC_INVALID_WIRE_VALUE:${value.kind}`);
}

function parseDenoWorkerMessage(line: string, token: string): DenoWorkerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (cause) {
    throw new Error("DENO_CODEMODE_RPC_MALFORMED_JSON", { cause });
  }
  if (!isRecord(value)) {
    throw new Error("DENO_CODEMODE_RPC_INVALID_ENVELOPE");
  }
  if (value.token !== token) {
    return null;
  }
  if (value.version !== DENO_CODEMODE_PROTOCOL_VERSION || typeof value.type !== "string") {
    throw new Error("DENO_CODEMODE_RPC_INVALID_ENVELOPE");
  }
  const budget = { valueCount: 0 };
  if (value.type === "callHost") {
    if (
      typeof value.id === "string" &&
      typeof value.referenceId === "string" &&
      (typeof value.method === "string" || value.method === null) &&
      Array.isArray(value.args) &&
      value.args.length <= DENO_CODEMODE_MAX_COLLECTION_ENTRIES
    ) {
      return {
        version: 1,
        token,
        type: "callHost",
        id: value.id,
        referenceId: value.referenceId,
        method: value.method,
        args: value.args.map((argument) => parseDenoWireValue(argument, budget)),
      };
    }
  } else if (value.type === "guestResult") {
    if (typeof value.id === "string" && typeof value.ok === "boolean") {
      return value.ok
        ? {
            version: 1,
            token,
            type: "guestResult",
            id: value.id,
            ok: true,
            value: parseDenoWireValue(value.value, budget),
          }
        : {
            version: 1,
            token,
            type: "guestResult",
            id: value.id,
            ok: false,
            error: typeof value.error === "string" ? value.error : "Deno guest call failed.",
          };
    }
  } else if (value.type === "complete" && typeof value.ok === "boolean") {
    return value.ok
      ? {
          version: 1,
          token,
          type: "complete",
          ok: true,
          value: parseDenoWireValue(value.value, budget),
        }
      : {
          version: 1,
          token,
          type: "complete",
          ok: false,
          error: typeof value.error === "string" ? value.error : "Deno codemode failed.",
        };
  }
  throw new Error(`DENO_CODEMODE_RPC_INVALID_MESSAGE:${value.type}`);
}

function encodeBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > DENO_CODEMODE_MAX_BINARY_BYTES) {
    throw new Error("DENO_CODEMODE_RPC_BINARY_LIMIT_EXCEEDED");
  }
  return Buffer.from(bytes).toString("base64");
}

function resolveDenoHostMethod(
  reference: WeakKey,
  methodName: string,
): ((...args: unknown[]) => unknown) | null {
  if (typeof reference === "function" || DENO_CODEMODE_BLOCKED_HOST_METHODS.has(methodName)) {
    return null;
  }

  for (
    let current: object | null = reference;
    current !== null && current !== Object.prototype && current !== Function.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, methodName);
    if (descriptor) {
      return typeof descriptor.value === "function"
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : null;
    }
  }
  return null;
}

function registerDenoHostReference(
  value: WeakKey,
  callable: boolean,
  context: DenoWireEncodingContext,
): DenoWireValue {
  const existingId = context.referenceIds.get(value);
  if (existingId) {
    return { kind: "remote", id: existingId, callable };
  }
  if (context.references.size >= DENO_CODEMODE_MAX_REMOTE_REFERENCES) {
    throw new Error("DENO_CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED");
  }
  const id = randomUUID();
  context.references.set(id, value);
  context.referenceIds.set(value, id);
  return { kind: "remote", id, callable };
}

function encodeDenoWireValue(
  value: unknown,
  context: DenoWireEncodingContext,
  depth = 0,
): DenoWireValue {
  context.budget.valueCount += 1;
  if (context.budget.valueCount > DENO_CODEMODE_MAX_WIRE_VALUES) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_VALUE_LIMIT_EXCEEDED");
  }
  if (depth > DENO_CODEMODE_MAX_WIRE_DEPTH) {
    throw new Error("DENO_CODEMODE_RPC_WIRE_DEPTH_LIMIT_EXCEEDED");
  }
  if (value === undefined) {
    return { kind: "undefined" };
  }
  if (value === null) {
    return { kind: "null" };
  }
  if (typeof value === "string") {
    return { kind: "string", value };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "special-number", value: String(value) };
  }
  if (typeof value === "bigint") {
    return { kind: "bigint", value: String(value) };
  }
  if (typeof value === "function") {
    return registerDenoHostReference(value, true, context);
  }
  if (typeof value !== "object") {
    throw new Error(`DENO_CODEMODE_RPC_UNSUPPORTED_VALUE:${typeof value}`);
  }
  if (value instanceof Date) {
    return { kind: "date", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { kind: "bytes", value: encodeBytes(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { kind: "array-buffer", value: encodeBytes(new Uint8Array(value)) };
  }
  if (context.ancestors.has(value)) {
    throw new Error("DENO_CODEMODE_RPC_CYCLIC_VALUE");
  }
  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > DENO_CODEMODE_MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return {
        kind: "array",
        value: value.map((entry) => encodeDenoWireValue(entry, context, depth + 1)),
      };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const entries = Object.entries(value);
      if (entries.length > DENO_CODEMODE_MAX_COLLECTION_ENTRIES) {
        throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
      }
      return {
        kind: "object",
        value: Object.fromEntries(
          entries.map(([key, entry]) => [key, encodeDenoWireValue(entry, context, depth + 1)]),
        ),
      };
    }
    return registerDenoHostReference(value, false, context);
  } finally {
    context.ancestors.delete(value);
  }
}

function encodeDenoWireValues(
  values: unknown[],
  references: Map<string, WeakKey>,
  referenceIds: WeakMap<WeakKey, string>,
): DenoWireValue[] {
  if (values.length > DENO_CODEMODE_MAX_COLLECTION_ENTRIES) {
    throw new Error("DENO_CODEMODE_RPC_COLLECTION_LIMIT_EXCEEDED");
  }
  const context: DenoWireEncodingContext = {
    references,
    referenceIds,
    budget: { valueCount: 0 },
    ancestors: new Set(),
  };
  return values.map((value) => encodeDenoWireValue(value, context));
}

const denoEvalArguments = () => [
  "eval",
  "--unstable-worker-options",
  "--no-config",
  "--no-lock",
  "--no-remote",
  "--no-npm",
  "--no-prompt",
  "--deny-read",
  "--deny-write",
  "--deny-net",
  "--deny-env",
  "--deny-sys",
  "--deny-run",
  "--deny-ffi",
  "--deny-import",
  "--v8-flags=--max-old-space-size=256",
  DENO_CODEMODE_RUNNER_SOURCE,
];

async function executeDenoWorker(input: {
  executable: string;
  mainModule: string;
  modules: Record<string, string>;
  method: string;
  args: unknown[];
}): Promise<unknown> {
  const denoDirectory = await mkdtemp(path.join(os.tmpdir(), "backoffice-deno-codemode-"));
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const token = randomUUID();
      const hostReferences = new Map<string, WeakKey>();
      const hostReferenceIds = new WeakMap<WeakKey, string>();
      const pendingGuestCalls = new Map<string, PendingDenoCall>();
      const activeHostCallIds = new Set<string>();
      const child = spawn(input.executable, denoEvalArguments(), {
        cwd: denoDirectory,
        env: {
          DENO_DIR: denoDirectory,
          DENO_NO_UPDATE_CHECK: "1",
          NO_COLOR: "1",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let settled = false;
      let queuedWriteBytes = 0;
      let writeQueue = Promise.resolve();
      let stdoutFrameChunks: Buffer[] = [];
      let stdoutFrameBytes = 0;

      const timeout = setTimeout(() => {
        finish({
          ok: false,
          error: new Error(
            `Deno codemode execution exceeded ${DENO_CODEMODE_HARD_TIMEOUT_MS} milliseconds.`,
          ),
        });
      }, DENO_CODEMODE_HARD_TIMEOUT_MS);

      function finish(result: { ok: true; value: unknown } | { ok: false; error: Error }) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        const processEndedError = new Error(
          "DENO_CODEMODE_RPC_PROCESS_ENDED_BEFORE_GUEST_CALL_COMPLETED",
        );
        for (const pending of pendingGuestCalls.values()) {
          pending.reject(processEndedError);
        }
        pendingGuestCalls.clear();
        activeHostCallIds.clear();
        hostReferences.clear();
        stdoutFrameChunks = [];
        stdoutFrameBytes = 0;
        if (result.ok) {
          resolve(result.value);
        } else {
          reject(result.error);
        }
      }

      function fail(error: unknown) {
        finish({
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }

      function writeDenoProtocolFrame(frame: Buffer): Promise<void> {
        return new Promise((resolveWrite, rejectWrite) => {
          if (settled || child.stdin.destroyed) {
            rejectWrite(new Error("DENO_CODEMODE_RPC_STDIN_CLOSED"));
            return;
          }
          let callbackCompleted = false;
          let drainCompleted = false;
          let completed = false;

          function cleanup() {
            child.stdin.off("error", rejectOnError);
            child.stdin.off("close", rejectOnClose);
            child.stdin.off("drain", markDrained);
          }
          function completeWrite() {
            if (!completed && callbackCompleted && drainCompleted) {
              completed = true;
              cleanup();
              resolveWrite();
            }
          }
          function rejectOnError(error: Error) {
            if (!completed) {
              completed = true;
              cleanup();
              rejectWrite(error);
            }
          }
          function rejectOnClose() {
            rejectOnError(new Error("DENO_CODEMODE_RPC_STDIN_CLOSED"));
          }
          function markDrained() {
            drainCompleted = true;
            completeWrite();
          }

          child.stdin.once("error", rejectOnError);
          child.stdin.once("close", rejectOnClose);
          const accepted = child.stdin.write(frame, (error) => {
            if (error) {
              rejectOnError(error);
              return;
            }
            callbackCompleted = true;
            completeWrite();
          });
          if (accepted) {
            drainCompleted = true;
          } else {
            child.stdin.once("drain", markDrained);
          }
          completeWrite();
        });
      }

      function send(message: Record<string, unknown>): Promise<void> {
        if (settled) {
          return Promise.reject(new Error("DENO_CODEMODE_RPC_PROCESS_ENDED"));
        }
        let frame: Buffer;
        try {
          frame = Buffer.from(`${JSON.stringify({ ...message, token })}\n`);
        } catch (cause) {
          return Promise.reject(new Error("DENO_CODEMODE_RPC_MESSAGE_ENCODING_FAILED", { cause }));
        }
        if (frame.byteLength > DENO_CODEMODE_MAX_FRAME_BYTES) {
          return Promise.reject(new Error("DENO_CODEMODE_RPC_FRAME_TOO_LARGE"));
        }
        if (queuedWriteBytes + frame.byteLength > DENO_CODEMODE_MAX_QUEUED_WRITE_BYTES) {
          return Promise.reject(new Error("DENO_CODEMODE_RPC_WRITE_QUEUE_LIMIT_EXCEEDED"));
        }
        queuedWriteBytes += frame.byteLength;
        const queuedWrite = writeQueue.then(async () => {
          await writeDenoProtocolFrame(frame);
        });
        writeQueue = queuedWrite.finally(() => {
          queuedWriteBytes -= frame.byteLength;
        });
        return writeQueue;
      }

      function callGuest(
        referenceId: string,
        method: string | null,
        args: unknown[],
      ): Promise<unknown> {
        if (pendingGuestCalls.size >= DENO_CODEMODE_MAX_PENDING_GUEST_CALLS) {
          const error = new Error("DENO_CODEMODE_RPC_GUEST_CALL_LIMIT_EXCEEDED");
          fail(error);
          return Promise.reject(error);
        }
        let encodedArgs: DenoWireValue[];
        try {
          encodedArgs = encodeDenoWireValues(args, hostReferences, hostReferenceIds);
        } catch (error) {
          const encodingError = error instanceof Error ? error : new Error(String(error));
          fail(encodingError);
          return Promise.reject(encodingError);
        }
        const id = randomUUID();
        return new Promise((resolveCall, rejectCall) => {
          pendingGuestCalls.set(id, { resolve: resolveCall, reject: rejectCall });
          void send({
            version: DENO_CODEMODE_PROTOCOL_VERSION,
            type: "callGuest",
            id,
            referenceId,
            method,
            args: encodedArgs,
          }).catch((error: unknown) => {
            const sendError = error instanceof Error ? error : new Error(String(error));
            pendingGuestCalls.delete(id);
            rejectCall(sendError);
            fail(sendError);
          });
        });
      }

      function createGuestReference(referenceId: string, callable: boolean): unknown {
        const invoke = (...args: unknown[]) => callGuest(referenceId, null, args);
        const target = callable ? invoke : {};
        return new Proxy(target, {
          get(_target, property) {
            if (property === "then") {
              return undefined;
            }
            if (typeof property !== "string") {
              return undefined;
            }
            return (...args: unknown[]) => callGuest(referenceId, property, args);
          },
          apply(_target, _thisArg, args: unknown[]) {
            return callGuest(referenceId, null, args);
          },
        });
      }

      function decode(value: DenoWireValue): unknown {
        switch (value.kind) {
          case "undefined":
            return undefined;
          case "null":
            return null;
          case "string":
          case "boolean":
          case "number":
            return value.value;
          case "special-number":
            return Number(value.value);
          case "bigint":
            return BigInt(value.value);
          case "date":
            return new Date(value.value);
          case "bytes":
            return new Uint8Array(Buffer.from(value.value, "base64"));
          case "array-buffer": {
            const bytes = new Uint8Array(Buffer.from(value.value, "base64"));
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          }
          case "array":
            return value.value.map(decode);
          case "object":
            return Object.fromEntries(
              Object.entries(value.value).map(([key, entry]) => [key, decode(entry)]),
            );
          case "remote":
            return createGuestReference(value.id, value.callable);
        }
        throw new Error("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE");
      }

      async function invokeHostReference(
        message: Extract<DenoWorkerMessage, { type: "callHost" }>,
      ) {
        const reference = hostReferences.get(message.referenceId);
        if (reference === undefined) {
          throw new Error("DENO_CODEMODE_RPC_HOST_REFERENCE_NOT_FOUND");
        }
        const args = message.args.map(decode);
        if (message.method === null) {
          if (typeof reference !== "function") {
            throw new Error("DENO_CODEMODE_RPC_HOST_REFERENCE_NOT_CALLABLE");
          }
          const callableReference = reference as (...callArgs: unknown[]) => unknown;
          return await callableReference(...args);
        }
        const member = resolveDenoHostMethod(reference, message.method);
        if (!member) {
          throw new Error(`DENO_CODEMODE_RPC_HOST_METHOD_NOT_FOUND:${message.method}`);
        }
        return await member.apply(reference, args);
      }

      async function answerHostCall(message: Extract<DenoWorkerMessage, { type: "callHost" }>) {
        try {
          let value: unknown;
          try {
            value = await invokeHostReference(message);
          } catch (error) {
            await send({
              version: DENO_CODEMODE_PROTOCOL_VERSION,
              type: "hostResult",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          const [encodedValue] = encodeDenoWireValues([value], hostReferences, hostReferenceIds);
          await send({
            version: DENO_CODEMODE_PROTOCOL_VERSION,
            type: "hostResult",
            id: message.id,
            ok: true,
            value: encodedValue,
          });
        } catch (error) {
          fail(error);
        } finally {
          activeHostCallIds.delete(message.id);
        }
      }

      function handleDenoProtocolLine(line: string) {
        let message: DenoWorkerMessage | null;
        try {
          message = parseDenoWorkerMessage(line, token);
        } catch (error) {
          fail(error);
          return;
        }
        if (!message) {
          return;
        }
        if (message.type === "complete") {
          try {
            finish(
              message.ok
                ? { ok: true, value: decode(message.value) }
                : { ok: false, error: new Error(message.error) },
            );
          } catch (error) {
            fail(error);
          }
          return;
        }
        if (message.type === "guestResult") {
          const pending = pendingGuestCalls.get(message.id);
          if (!pending) {
            fail(new Error(`DENO_CODEMODE_RPC_UNKNOWN_GUEST_RESULT:${message.id}`));
            return;
          }
          pendingGuestCalls.delete(message.id);
          if (message.ok) {
            try {
              pending.resolve(decode(message.value));
            } catch (error) {
              const decodeError = error instanceof Error ? error : new Error(String(error));
              pending.reject(decodeError);
              fail(decodeError);
            }
          } else {
            pending.reject(new Error(message.error));
          }
          return;
        }
        if (activeHostCallIds.has(message.id)) {
          fail(new Error(`DENO_CODEMODE_RPC_DUPLICATE_HOST_CALL:${message.id}`));
          return;
        }
        if (activeHostCallIds.size >= DENO_CODEMODE_MAX_ACTIVE_HOST_CALLS) {
          fail(new Error("DENO_CODEMODE_RPC_HOST_CALL_LIMIT_EXCEEDED"));
          return;
        }
        activeHostCallIds.add(message.id);
        void answerHostCall(message);
      }

      function appendStdoutFrameChunk(chunk: Buffer) {
        if (stdoutFrameBytes + chunk.byteLength > DENO_CODEMODE_MAX_FRAME_BYTES) {
          fail(new Error("DENO_CODEMODE_RPC_FRAME_TOO_LARGE"));
          return;
        }
        if (chunk.byteLength > 0) {
          stdoutFrameChunks.push(chunk);
          stdoutFrameBytes += chunk.byteLength;
        }
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        let offset = 0;
        while (offset < chunk.byteLength && !settled) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline === -1) {
            appendStdoutFrameChunk(chunk.subarray(offset));
            return;
          }
          appendStdoutFrameChunk(chunk.subarray(offset, newline));
          if (settled) {
            return;
          }
          if (stdoutFrameBytes + 1 > DENO_CODEMODE_MAX_FRAME_BYTES) {
            fail(new Error("DENO_CODEMODE_RPC_FRAME_TOO_LARGE"));
            return;
          }
          const line = Buffer.concat(stdoutFrameChunks, stdoutFrameBytes).toString("utf8");
          stdoutFrameChunks = [];
          stdoutFrameBytes = 0;
          handleDenoProtocolLine(line);
          offset = newline + 1;
        }
      });
      child.stdout.on("end", () => {
        if (!settled && stdoutFrameBytes > 0) {
          fail(new Error("DENO_CODEMODE_RPC_TRUNCATED_FRAME"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < DENO_CODEMODE_STDERR_LIMIT) {
          stderr += chunk.toString().slice(0, DENO_CODEMODE_STDERR_LIMIT - stderr.length);
        }
      });
      child.stdin.on("error", fail);
      child.on("error", (error) => {
        fail(
          new Error(`Deno codemode process failed to start: ${error.message}`, {
            cause: error,
          }),
        );
      });
      child.on("exit", (code, signal) => {
        if (!settled) {
          const detail = stderr.trim();
          fail(
            new Error(
              `Deno codemode process exited before completing (code ${String(code)}, signal ${String(signal)}).${detail ? ` ${detail}` : ""}`,
            ),
          );
        }
      });

      let encodedArguments: DenoWireValue[];
      try {
        encodedArguments = encodeDenoWireValues(input.args, hostReferences, hostReferenceIds);
      } catch (error) {
        fail(error);
        return;
      }
      void send({
        version: DENO_CODEMODE_PROTOCOL_VERSION,
        type: "start",
        mainModule: input.mainModule,
        modules: input.modules,
        method: input.method,
        args: encodedArguments,
      }).catch(fail);
    });
  } finally {
    await rm(denoDirectory, { recursive: true, force: true });
  }
}

function listExecutablePathsFromEnvironment(command: string): string[] {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [path.resolve(command)];
  }

  const executableExtensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const commandAlreadyHasExecutableExtension = executableExtensions.some(
    (extension) => extension !== "" && command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  const commandExtensions = commandAlreadyHasExecutableExtension ? [""] : executableExtensions;
  const executablePath = process.env.PATH ?? process.env.Path ?? "";
  return executablePath
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      commandExtensions.map((extension) => path.join(directory, `${command}${extension}`)),
    );
}

/** Verifies the configured Deno executable before the Node server accepts traffic. */
export async function verifyDenoCodemodeExecutable(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      env: {
        DENO_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Deno codemode executable verification timed out."));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(`Deno codemode executable '${executable}' could not be started.`, {
          cause: error,
        }),
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.startsWith("deno ")) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Deno codemode executable '${executable}' failed verification.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

/** Resolves Deno from explicit configuration, PATH, DENO_INSTALL, or the standard user install. */
export async function resolveDenoCodemodeExecutable(
  configuredExecutable: string | undefined,
): Promise<string> {
  const executableName = process.platform === "win32" ? "deno.exe" : "deno";
  const candidates = configuredExecutable
    ? listExecutablePathsFromEnvironment(configuredExecutable)
    : [
        ...listExecutablePathsFromEnvironment(executableName),
        ...(process.env.DENO_INSTALL
          ? [path.join(process.env.DENO_INSTALL, "bin", executableName)]
          : []),
        path.join(os.homedir(), ".deno", "bin", executableName),
      ];
  const failures: string[] = [];
  for (const candidate of new Set(candidates)) {
    try {
      await verifyDenoCodemodeExecutable(candidate);
      return candidate;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Deno codemode executable was not found. ${failures.join(" ")}`);
}

/** Creates a Worker Loader whose untrusted entrypoints execute in denied-permission Deno workers. */
export function createDenoWorkerLoader(executable: string): WorkerLoader {
  return {
    get(_name: string, factory: DenoWorkerFactory) {
      const worker = factory();
      if (worker.globalOutbound) {
        throw new Error("Deno codemode does not support a global outbound fetch capability.");
      }
      const entrypoint = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === Symbol.dispose) {
              return () => {};
            }
            if (typeof property !== "string") {
              return undefined;
            }
            return (...args: unknown[]) =>
              executeDenoWorker({
                executable,
                mainModule: worker.mainModule,
                modules: worker.modules,
                method: property,
                args,
              });
          },
        },
      );
      return { getEntrypoint: () => entrypoint };
    },
  } as unknown as WorkerLoader;
}
