import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { isMainThread } from "node:worker_threads";

import { RpcPromise, RpcStub, RpcTarget } from "capnweb";

import {
  bindNodeObjectInput,
  deliverNodeObjectIO,
  runOutsideNodeObjectInput,
} from "./node-object-input-gate";

type NativeFunction = (this: unknown, ...args: unknown[]) => unknown;
type InputTimerToken = { cancelled: boolean; generation: number; queued: boolean };

const require = createRequire(import.meta.url);
const nativeQueueMicrotask = queueMicrotask;
let installed = false;

/** Installs application I/O facades only in object workers, before their factories are imported. */
export function installNodeObjectWorkerIO(): void {
  if (isMainThread) {
    throw new Error("NODE_OBJECT_WORKER_IO_REQUIRES_WORKER");
  }
  if (installed) {
    return;
  }
  installed = true;

  const crypto = require("node:crypto") as Record<string, unknown>;
  for (const name of [
    "scrypt",
    "pbkdf2",
    "randomBytes",
    "randomFill",
    "generateKey",
    "generateKeyPair",
    "generatePrime",
    "checkPrime",
  ]) {
    wrapCallbackMethod(crypto, name);
  }

  const timers = require("node:timers") as Record<string, unknown>;
  const timerTokens = new WeakMap<object, InputTimerToken>();
  const numberedTimers = new Map<number, InputTimerToken>();
  for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
    const original = timers[name] as NativeFunction;
    const wrapped = preserveNativeFunction(original, function (callback, ...args) {
      if (
        typeof callback !== "function" ||
        bindNodeObjectInput(callback as NativeFunction) === null
      ) {
        return original.call(this, callback, ...args);
      }
      const registeredCallback = callback as NativeFunction;
      const token: InputTimerToken = { cancelled: false, generation: 0, queued: false };
      let timerId: number | null = null;
      const admit = bindNodeObjectInput(
        (receiver: unknown, values: unknown[], generation: number) => {
          if (generation !== token.generation) {
            return undefined;
          }
          token.queued = false;
          if (name !== "setInterval" && timerId !== null) {
            numberedTimers.delete(timerId);
          }
          return token.cancelled ? undefined : registeredCallback.apply(receiver, values);
        },
      )!;
      const completion = function (this: unknown, ...values: unknown[]) {
        // A blocked interval has one pending tick, like a timer on a blocked native event loop.
        if (token.cancelled || token.queued) {
          return;
        }
        token.queued = true;
        void admit(this, values, token.generation).catch(reportNativeInputFailure);
      };
      const timer = runOutsideNodeObjectInput(() => original.call(this, completion, ...args)) as
        | NodeJS.Timeout
        | NodeJS.Immediate;
      const timerProperties = timer as unknown as Record<PropertyKey, unknown>;
      timerTokens.set(timer, token);
      if (name !== "setImmediate") {
        const id = Number(timer);
        timerId = id;
        numberedTimers.set(id, token);
        const refresh = timerProperties["refresh"] as NativeFunction;
        Object.defineProperty(timer, "refresh", {
          value: function (this: NodeJS.Timeout) {
            token.generation += 1;
            token.cancelled = false;
            token.queued = false;
            if (timerId !== null) {
              numberedTimers.delete(timerId);
            }
            const result = refresh.call(this);
            timerId = Number(this);
            numberedTimers.set(timerId, token);
            return result;
          },
        });
      }
      const dispose = timerProperties[Symbol.dispose] as NativeFunction;
      Object.defineProperty(timer, Symbol.dispose, {
        value: function (this: NodeJS.Timeout | NodeJS.Immediate) {
          token.cancelled = true;
          token.generation += 1;
          token.queued = false;
          if (timerId !== null) {
            numberedTimers.delete(timerId);
          }
          return dispose.call(this);
        },
      });
      return timer;
    });
    timers[name] = wrapped;
    Reflect.set(globalThis, name, wrapped);
  }
  for (const name of ["clearTimeout", "clearInterval", "clearImmediate"]) {
    const original = timers[name] as NativeFunction;
    const wrapped = preserveNativeFunction(original, function (timer) {
      const token =
        typeof timer === "number"
          ? numberedTimers.get(timer)
          : timer !== null && typeof timer === "object"
            ? timerTokens.get(timer)
            : undefined;
      if (token) {
        token.cancelled = true;
        token.generation += 1;
        token.queued = false;
      }
      if (typeof timer === "number") {
        numberedTimers.delete(timer);
      } else if (timer !== null && typeof timer === "object" && name !== "clearImmediate") {
        numberedTimers.delete(Number(timer));
      }
      return original.call(this, timer);
    });
    timers[name] = wrapped;
    Reflect.set(globalThis, name, wrapped);
  }
  const timerPromises = require("node:timers/promises") as Record<string, unknown>;
  for (const name of ["setTimeout", "setImmediate"]) {
    wrapPromiseMethod(timerPromises, name);
  }
  wrapIteratorMethod(timerPromises, "setInterval");
  const scheduler = timerPromises["scheduler"] as Record<string, unknown>;
  for (const name of ["wait", "yield"]) {
    wrapPromiseMethod(scheduler, name);
  }

  const filesystem = require("node:fs") as Record<string, unknown>;
  const filesystemPromises = require("node:fs/promises") as Record<string, unknown>;
  const filesystemMethods = [
    "access",
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "lchmod",
    "lchown",
    "link",
    "lstat",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "opendir",
    "readFile",
    "readdir",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "statfs",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ];
  for (const name of filesystemMethods) {
    wrapCallbackMethod(filesystem, name);
    wrapPromiseMethod(filesystemPromises, name);
  }
  for (const name of [
    "open",
    "close",
    "read",
    "readv",
    "write",
    "writev",
    "fsync",
    "fdatasync",
    "fstat",
  ]) {
    wrapCallbackMethod(filesystem, name);
  }

  wrapIteratorMethod(filesystemPromises, "watch");

  const openFile = filesystemPromises["open"] as NativeFunction;
  const fileHandlePrototypes = new WeakSet<object>();
  filesystemPromises["open"] = function (this: unknown, ...args: unknown[]) {
    const opened = runOutsideNodeObjectInput(() => openFile.apply(this, args)) as Promise<object>;
    return deliverNodeObjectIO(
      opened.then((handle) => {
        const prototype = Object.getPrototypeOf(handle) as Record<string, unknown>;
        if (!fileHandlePrototypes.has(prototype)) {
          fileHandlePrototypes.add(prototype);
          for (const name of [
            "appendFile",
            "chmod",
            "chown",
            "datasync",
            "read",
            "readFile",
            "readv",
            "stat",
            "sync",
            "truncate",
            "utimes",
            "write",
            "writeFile",
            "writev",
          ]) {
            wrapPromiseMethod(prototype, name);
          }
        }
        wrapPromiseMethod(handle as Record<string, unknown>, "close");
        return handle;
      }),
    );
  };

  wrapPromiseMethod(globalThis as unknown as Record<string, unknown>, "fetch");
  for (const prototype of [Request.prototype, Response.prototype]) {
    for (const name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
      wrapPromiseMethod(prototype as unknown as Record<string, unknown>, name);
    }
  }
  for (const prototype of [
    ReadableStreamDefaultReader.prototype,
    ReadableStreamBYOBReader.prototype,
  ]) {
    for (const name of ["read", "cancel"]) {
      wrapPromiseMethod(prototype as unknown as Record<string, unknown>, name);
    }
  }
  for (const name of ["cancel", "pipeTo"]) {
    wrapPromiseMethod(ReadableStream.prototype as unknown as Record<string, unknown>, name);
  }
  for (const name of ["values", Symbol.asyncIterator]) {
    wrapIteratorMethod(ReadableStream.prototype as unknown as Record<string, unknown>, name);
  }
  for (const name of ["write", "close", "abort"]) {
    wrapPromiseMethod(
      WritableStreamDefaultWriter.prototype as unknown as Record<string, unknown>,
      name,
    );
  }
  const subtle = Object.getPrototypeOf(globalThis.crypto.subtle) as Record<string, unknown>;
  for (const name of [
    "digest",
    "encrypt",
    "decrypt",
    "sign",
    "verify",
    "deriveBits",
    "deriveKey",
    "generateKey",
    "importKey",
    "exportKey",
    "wrapKey",
    "unwrapKey",
  ]) {
    wrapPromiseMethod(subtle, name);
  }

  installAbortSignalInput();

  // Cap'n Web exposes results as thenable capabilities. Gate their settlement, not the shared
  // transport: owning RPC replies and authority/control traffic must remain able to progress.
  const rpcPrototype = Object.getPrototypeOf(new RpcPromise(Promise.resolve(null))) as Record<
    string,
    unknown
  >;
  const rpcThen = rpcPrototype["then"] as NativeFunction;
  // eslint-disable-next-line unicorn/no-thenable -- Cap'n Web already owns this promise protocol.
  rpcPrototype["then"] = function (this: unknown, fulfilled: unknown, rejected: unknown) {
    const result = rpcThen.call(this) as Promise<unknown>;
    return deliverNodeObjectIO(result)
      .then(bindNodeObjectRpcValue)
      .then(
        fulfilled as ((value: unknown) => unknown) | undefined,
        rejected as ((error: unknown) => unknown) | undefined,
      );
  };
  rpcPrototype["catch"] = function (this: unknown, rejected: unknown) {
    return (rpcPrototype["then"] as NativeFunction).call(this, undefined, rejected);
  };
  rpcPrototype["finally"] = function (this: unknown, settled: unknown) {
    const result = rpcThen.call(this) as Promise<unknown>;
    return deliverNodeObjectIO(result).finally(settled as (() => void) | undefined);
  };

  // Socket/EventEmitter protocol callbacks stay native. A shared connection may carry an
  // owning reply while another request's response is gated; pausing its parser would deadlock.
  // Application delivery is gated at fetch/body reads and Cap'n Web result settlement instead.

  // Both CJS and ESM dependencies must see the same producer-owned facades. Native Node modules
  // cached before bootstrap otherwise keep their unguarded named exports.
  syncBuiltinESMExports();
}

const boundRpcInputs = new WeakMap<object, object>();

/** Binds exported callbacks and received capabilities without trusting caller-supplied ownership. */
export function bindNodeObjectRpcValue(value: unknown): unknown {
  if (value instanceof RpcStub) {
    const cached = boundRpcInputs.get(value);
    if (cached) {
      return cached;
    }
    const callable = value as unknown as NativeFunction;
    const capability = new Proxy(callable, {
      apply(target, receiver, args) {
        // RpcStub shadows .apply with a remote property; invoke its callable native slot.
        return bindNodeObjectRpcValue(
          Function.prototype.apply.call(target, receiver, args.map(bindNodeObjectRpcValue)),
        );
      },
      get(target, property) {
        const properties = target as unknown as Record<PropertyKey, unknown>;
        const member = properties[property];
        return member instanceof RpcStub ? bindNodeObjectRpcValue(member) : member;
      },
    });
    boundRpcInputs.set(value, capability);
    boundRpcInputs.set(capability, capability);
    return capability;
  }
  if (value instanceof RpcTarget) {
    const enter = bindNodeObjectInput((callback: () => unknown) => callback());
    if (enter === null) {
      return value;
    }
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(value, {
      get(target, property) {
        if (methods.has(property)) {
          return methods.get(property);
        }
        const properties = target as unknown as Record<PropertyKey, unknown>;
        const member = properties[property];
        if (
          typeof member !== "function" ||
          typeof property !== "string" ||
          property === "constructor"
        ) {
          return member;
        }
        const method = member as NativeFunction;
        const bound = (...args: unknown[]) =>
          enter(() => method.apply(target, args.map(bindNodeObjectRpcValue)));
        methods.set(property, bound);
        return bound;
      },
    });
  }
  if (typeof value === "function") {
    return bindNodeObjectInput(value as (...args: unknown[]) => unknown) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(bindNodeObjectRpcValue);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bindNodeObjectRpcValue(item)]),
    );
  }
  return value;
}

function wrapCallbackMethod(target: Record<string, unknown>, name: string): void {
  const original = target[name];
  if (typeof original !== "function") {
    return;
  }
  const native = original as NativeFunction;
  const wrapped: NativeFunction = function (this: unknown, ...args: unknown[]) {
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      args[last] = wrapNativeCallback(args[last] as NativeFunction);
    }
    return runOutsideNodeObjectInput(() => native.apply(this, args));
  };
  target[name] = preserveNativeFunction(native, wrapped);
}

function wrapPromiseMethod(target: Record<string, unknown>, name: string): void {
  const original = target[name];
  if (typeof original !== "function") {
    return;
  }
  const native = original as NativeFunction;
  target[name] = preserveNativeFunction(native, function (this: unknown, ...args: unknown[]) {
    const result = runOutsideNodeObjectInput(() => native.apply(this, args)) as Promise<unknown>;
    return deliverNodeObjectIO(result);
  });
}

function wrapIteratorMethod(target: Record<string, unknown>, name: PropertyKey): void {
  const properties = target as Record<PropertyKey, unknown>;
  const native = properties[name] as NativeFunction;
  Reflect.set(
    target,
    name,
    preserveNativeFunction(native, function (this: unknown, ...args: unknown[]) {
      const iterator = runOutsideNodeObjectInput(() =>
        native.apply(this, args),
      ) as AsyncIterator<unknown>;
      const facade = {
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      for (const operation of ["next", "return", "throw"] as const) {
        const method = iterator[operation] as NativeFunction | undefined;
        if (method) {
          Reflect.set(facade, operation, function (...values: unknown[]) {
            const result = runOutsideNodeObjectInput(() =>
              method.apply(iterator, values),
            ) as Promise<IteratorResult<unknown>>;
            return deliverNodeObjectIO(result);
          });
        }
      }
      return facade;
    }),
  );
}

function installAbortSignalInput(): void {
  const native = AbortSignal.prototype as unknown as Record<string, NativeFunction>;
  const add = native["addEventListener"] as EventTarget["addEventListener"];
  const remove = native["removeEventListener"] as EventTarget["removeEventListener"];
  const signals = new WeakMap<
    AbortSignal,
    WeakMap<object, Map<boolean, EventListenerOrEventListenerObject>>
  >();
  AbortSignal.prototype.addEventListener = function (
    this: AbortSignal,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type !== "abort" || listener === null) {
      add.call(this, type, listener, options);
      return;
    }
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    let listeners = signals.get(this);
    if (!listeners) {
      listeners = new WeakMap();
      signals.set(this, listeners);
    }
    let captures = listeners.get(listener);
    if (!captures) {
      captures = new Map();
      listeners.set(listener, captures);
    }
    let wrapped = captures.get(capture);
    if (!wrapped) {
      wrapped = wrapNativeCallback(function (this: unknown, ...args: unknown[]) {
        const event = args[0] as Event;
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      }) as EventListener;
      captures.set(capture, wrapped);
    }
    runOutsideNodeObjectInput(() => {
      add.call(this, type, wrapped, options);
    });
  };
  AbortSignal.prototype.removeEventListener = function (
    this: AbortSignal,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (type !== "abort" || listener === null) {
      remove.call(this, type, listener, options);
      return;
    }
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const wrapped = signals.get(this)?.get(listener)?.get(capture) ?? listener;
    signals.get(this)?.get(listener)?.delete(capture);
    remove.call(this, type, wrapped, options);
  };
}

function preserveNativeFunction(native: NativeFunction, wrapped: NativeFunction): NativeFunction {
  const descriptors = Object.getOwnPropertyDescriptors(native);
  const custom = Object.getOwnPropertyDescriptor(native, promisify.custom);
  if (custom && typeof custom.value === "function") {
    const operation = custom.value as NativeFunction;
    Reflect.set(descriptors, promisify.custom, {
      ...custom,
      value: function (this: unknown, ...args: unknown[]) {
        const result = runOutsideNodeObjectInput(() =>
          operation.apply(this, args),
        ) as Promise<unknown>;
        return deliverNodeObjectIO(result);
      },
    });
  }
  Object.defineProperties(wrapped, descriptors);
  return wrapped;
}

function wrapNativeCallback(callback: NativeFunction): NativeFunction {
  const input = bindNodeObjectInput((receiver: unknown, args: unknown[]) =>
    callback.apply(receiver, args),
  );
  if (input === null) {
    return callback;
  }
  const wrapped = function (this: unknown, ...args: unknown[]) {
    void input(this, args).catch(reportNativeInputFailure);
  };
  return wrapped;
}

function reportNativeInputFailure(error: unknown): void {
  if (error instanceof Error && error.message === "NODE_OBJECT_INPUT_GATE_CLOSED") {
    return;
  }
  nativeQueueMicrotask(() => {
    throw error;
  });
}
