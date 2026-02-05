export function resolveOutboxRefs<T extends Record<string, unknown>>(
  mutation: T,
  refMap: Record<string, string>,
): T {
  if ("values" in mutation && isRecord(mutation["values"])) {
    return {
      ...mutation,
      values: resolveRecordRefs(mutation["values"], refMap),
    } as T;
  }

  if ("set" in mutation && isRecord(mutation["set"])) {
    return {
      ...mutation,
      set: resolveRecordRefs(mutation["set"], refMap),
    } as T;
  }

  return mutation;
}

function resolveRecordRefs(
  values: Record<string, unknown>,
  refMap: Record<string, string>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (isRefPlaceholder(value)) {
      const refKey = value.__fragno_ref;
      const resolvedValue = refMap[refKey];
      if (!resolvedValue) {
        throw new Error(`Outbox ref ${refKey} not found`);
      }
      resolved[key] = resolvedValue;
      continue;
    }

    resolved[key] = value;
  }

  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RefPlaceholder = { __fragno_ref: string };

function isRefPlaceholder(value: unknown): value is RefPlaceholder {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === 1 && keys[0] === "__fragno_ref" && typeof value["__fragno_ref"] === "string"
  );
}
