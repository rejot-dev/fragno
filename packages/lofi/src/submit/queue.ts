import superjson from "superjson";

import type {
  LofiAdapter,
  LofiSubmitCommand,
  LofiSubmitConflictReason,
  LofiSubmitRequest,
  LofiSubmitResponse,
} from "../types";

export type SubmitQueue = LofiSubmitCommand[];

export type PendingSubmitState = {
  request: LofiSubmitRequest;
  response?: LofiSubmitResponse;
};

const CONFLICT_REASONS = new Set<LofiSubmitConflictReason>([
  "conflict",
  "write_congestion",
  "client_far_behind",
  "no_commands",
  "already_handled",
  "limit_exceeded",
]);

export const defaultQueueKey = (endpointName: string) => `${endpointName}::submit-queue`;
export const pendingSubmitKey = (endpointName: string) => `${endpointName}::submit-pending`;

export const buildCommandKey = (command: {
  target: { fragment: string; schema: string };
  name: string;
}): string => `${command.target.fragment}::${command.target.schema}::${command.name}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const decodeMetaValue = (raw: string, key: string): unknown => {
  try {
    return superjson.deserialize(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Failed to decode persisted Lofi meta value for ${key}`, { cause: error });
  }
};

const parseSubmitCommand = (value: unknown, index: number): LofiSubmitCommand => {
  if (!isRecord(value)) {
    throw new Error(`Submit queue entry at index ${index} must be an object`);
  }

  const { id, name, target } = value;
  if (!isNonEmptyString(id)) {
    throw new Error(`Submit queue entry at index ${index} is missing a valid id`);
  }
  if (!isNonEmptyString(name)) {
    throw new Error(`Submit queue entry at index ${index} is missing a valid name`);
  }
  if (!isRecord(target)) {
    throw new Error(`Submit queue entry at index ${index} is missing a valid target`);
  }
  const fragment = target["fragment"];
  const schema = target["schema"];
  if (!isNonEmptyString(fragment) || !isNonEmptyString(schema)) {
    throw new Error(`Submit queue entry at index ${index} has an invalid target`);
  }

  return {
    id,
    name,
    target: {
      fragment,
      schema,
    },
    input: value["input"],
  };
};

const parseSubmitQueue = (value: unknown, key: string): SubmitQueue => {
  if (!Array.isArray(value)) {
    throw new Error(`Persisted submit queue for ${key} must be an array`);
  }

  return value.map((entry, index) => parseSubmitCommand(entry, index));
};

const parseSubmitRequest = (value: unknown, key: string): LofiSubmitRequest => {
  if (!isRecord(value)) {
    throw new Error(`Persisted submit request for ${key} must be an object`);
  }

  const { requestId, adapterIdentity, baseVersionstamp, conflictResolutionStrategy, commands } =
    value;

  if (!isNonEmptyString(requestId)) {
    throw new Error(`Persisted submit request for ${key} is missing requestId`);
  }
  if (!isNonEmptyString(adapterIdentity)) {
    throw new Error(`Persisted submit request for ${key} is missing adapterIdentity`);
  }
  if (!isOptionalString(baseVersionstamp)) {
    throw new Error(`Persisted submit request for ${key} has an invalid baseVersionstamp`);
  }
  if (conflictResolutionStrategy !== "server" && conflictResolutionStrategy !== "disabled") {
    throw new Error(
      `Persisted submit request for ${key} has an invalid conflictResolutionStrategy`,
    );
  }

  return {
    requestId,
    adapterIdentity,
    baseVersionstamp,
    conflictResolutionStrategy,
    commands: parseSubmitQueue(commands, `${key}.commands`),
  };
};

const parseSubmitResponse = (value: unknown, key: string): LofiSubmitResponse => {
  if (!isRecord(value)) {
    throw new Error(`Persisted submit response for ${key} must be an object`);
  }

  const { status, requestId, confirmedCommandIds, entries, lastVersionstamp } = value;
  if (status !== "applied" && status !== "conflict") {
    throw new Error(`Persisted submit response for ${key} has an invalid status`);
  }
  if (!isNonEmptyString(requestId)) {
    throw new Error(`Persisted submit response for ${key} is missing requestId`);
  }
  if (!Array.isArray(confirmedCommandIds) || !confirmedCommandIds.every(isNonEmptyString)) {
    throw new Error(`Persisted submit response for ${key} has invalid confirmedCommandIds`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`Persisted submit response for ${key} has invalid entries`);
  }
  if (!isOptionalString(lastVersionstamp)) {
    throw new Error(`Persisted submit response for ${key} has an invalid lastVersionstamp`);
  }

  if (status === "applied") {
    return {
      status,
      requestId,
      confirmedCommandIds,
      entries,
      lastVersionstamp,
    };
  }

  const reason = value["reason"];
  const conflictCommandId = value["conflictCommandId"];
  if (!CONFLICT_REASONS.has(reason as LofiSubmitConflictReason)) {
    throw new Error(`Persisted submit response for ${key} has an invalid reason`);
  }
  if (!isOptionalString(conflictCommandId)) {
    throw new Error(`Persisted submit response for ${key} has an invalid conflictCommandId`);
  }

  return {
    status,
    requestId,
    confirmedCommandIds,
    conflictCommandId,
    entries,
    lastVersionstamp,
    reason: reason as LofiSubmitConflictReason,
  };
};

export const loadSubmitQueue = async (
  adapter: Pick<LofiAdapter, "getMeta">,
  key: string,
): Promise<SubmitQueue> => {
  const raw = await adapter.getMeta(key);
  if (!raw) {
    return [];
  }

  return parseSubmitQueue(decodeMetaValue(raw, key), key);
};

export const storeSubmitQueue = async (
  adapter: Pick<LofiAdapter, "setMeta">,
  key: string,
  queue: SubmitQueue,
): Promise<void> => {
  const serialized = superjson.serialize(queue);
  await adapter.setMeta(key, JSON.stringify(serialized));
};

export const loadPendingSubmit = async (
  adapter: Pick<LofiAdapter, "getMeta">,
  key: string,
): Promise<PendingSubmitState | undefined> => {
  const raw = await adapter.getMeta(key);
  if (!raw) {
    return undefined;
  }

  const decoded = decodeMetaValue(raw, key);
  if (decoded == null) {
    return undefined;
  }
  if (!isRecord(decoded)) {
    throw new Error(`Persisted submit state for ${key} must be an object`);
  }

  const request = parseSubmitRequest(decoded["request"], `${key}.request`);
  const response =
    decoded["response"] === undefined
      ? undefined
      : parseSubmitResponse(decoded["response"], `${key}.response`);

  if (response && response.requestId !== request.requestId) {
    throw new Error(`Persisted submit state for ${key} has mismatched request ids`);
  }

  return {
    request,
    ...(response === undefined ? {} : { response }),
  };
};

export const storePendingSubmit = async (
  adapter: Pick<LofiAdapter, "setMeta">,
  key: string,
  state: PendingSubmitState | undefined,
): Promise<void> => {
  const serialized = superjson.serialize(state ?? null);
  await adapter.setMeta(key, JSON.stringify(serialized));
};
