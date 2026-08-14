export type PiHarnessJsonValue =
  | null
  | boolean
  | number
  | string
  | PiHarnessJsonValue[]
  | { [key: string]: PiHarnessJsonValue };

const jsonValueError = (path: string, reason: string): Error =>
  new Error(`PI_HARNESS_EVENT_VALUE_NOT_JSON_COMPATIBLE:${path}:${reason}`);

const snapshotJsonValueAtPath = (
  value: unknown,
  path: string,
  ancestors: Set<object>,
): PiHarnessJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw jsonValueError(path, "non-finite-number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw jsonValueError(path, typeof value);
  }
  if (ancestors.has(value)) {
    throw jsonValueError(path, "cycle");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const snapshot: PiHarnessJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw jsonValueError(`${path}[${index}]`, "sparse-array-entry");
        }
        snapshot.push(snapshotJsonValueAtPath(value[index], `${path}[${index}]`, ancestors));
      }
      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonValueError(path, "non-plain-object");
    }

    const snapshot: Record<string, PiHarnessJsonValue> = {};
    for (const key of Object.keys(value)) {
      const propertyValue = (value as Record<string, unknown>)[key];
      // JSON omits undefined optional object properties. Pi uses these on otherwise valid messages.
      if (propertyValue === undefined) {
        continue;
      }
      snapshot[key] = snapshotJsonValueAtPath(propertyValue, `${path}.${key}`, ancestors);
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
};

/** Validates and detaches a value at the workflow JSON boundary. */
export const snapshotPiHarnessJsonValue = <T>(value: T, path = "$event"): T =>
  snapshotJsonValueAtPath(value, path, new Set()) as T;

const assertJsonValueAtPath = (value: unknown, path: string, ancestors: Set<object>): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw jsonValueError(path, "non-finite-number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw jsonValueError(path, typeof value);
  }
  if (ancestors.has(value)) {
    throw jsonValueError(path, "cycle");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw jsonValueError(`${path}[${index}]`, "sparse-array-entry");
        }
        assertJsonValueAtPath(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonValueError(path, "non-plain-object");
    }
    for (const key of Object.keys(value)) {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (propertyValue !== undefined) {
        assertJsonValueAtPath(propertyValue, `${path}.${key}`, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
};

/** Validates persisted protocol input without copying it. */
export const assertPiHarnessJsonValue = (value: unknown, path = "$event"): void => {
  assertJsonValueAtPath(value, path, new Set());
};

const freezeJsonValue = (value: unknown, visited: Set<object>): void => {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    freezeJsonValue(child, visited);
  }
  Object.freeze(value);
};

/** Validates and freezes persisted protocol input so interned references remain immutable. */
export const freezePiHarnessJsonValue = <T>(value: T, path = "$event"): T => {
  assertPiHarnessJsonValue(value, path);
  freezeJsonValue(value, new Set());
  return value;
};
