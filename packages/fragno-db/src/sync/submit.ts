import { ConcurrencyConflictError } from "../query/unit-of-work/execute-unit-of-work";
import type { OutboxEntry } from "../outbox/outbox";
import type { SubmitResponse, SubmitConflictReason, SyncCommandDefinition } from "./types";

export const DEFAULT_MAX_COMMANDS_PER_SUBMIT = 100;
export const DEFAULT_MAX_UNSEEN_MUTATIONS = 10_000;

export type SyncRequestRecord = {
  requestId: string;
  status: "applied" | "conflict";
  confirmedCommandIds: string[];
  conflictCommandId?: string;
  baseVersionstamp?: string;
  lastVersionstamp?: string;
};

export type SyncCommandResolution = {
  command: SyncCommandDefinition;
  namespace: string | null;
};

export type SyncSubmitRuntime = {
  getAdapterIdentity: () => Promise<string>;
  listOutboxEntries: (afterVersionstamp?: string) => Promise<OutboxEntry[]>;
  countOutboxMutations: (afterVersionstamp?: string) => Promise<number>;
  getSyncRequest: (requestId: string) => Promise<SyncRequestRecord | undefined>;
  storeSyncRequest: (record: SyncRequestRecord) => Promise<void>;
  resolveCommand: (
    fragment: string,
    schema: string,
    name: string,
  ) => SyncCommandResolution | undefined;
  createCommandContext: (command: SyncCommandDefinition) => unknown;
  executeCommand: (command: SyncCommandDefinition, input: unknown, ctx: unknown) => Promise<void>;
  maxCommandsPerSubmit?: number;
  maxUnseenMutations?: number;
};

export type SyncSubmitError = {
  status: "error";
  statusCode: number;
  body: {
    error: {
      code: string;
      message: string;
      detail?: string;
    };
  };
};

export type SyncSubmitResult =
  | {
      status: "ok";
      response: SubmitResponse;
    }
  | SyncSubmitError;

const VALID_CONFLICT_RESOLUTION = new Set(["server", "disabled"] as const);
const VERSIONSTAMP_REGEX = /^[0-9a-f]{24}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeVersionstamp = (value: string | undefined): string | undefined =>
  value ? value.toLowerCase() : undefined;

const isValidVersionstamp = (value: string): boolean => VERSIONSTAMP_REGEX.test(value);

const buildError = (code: string, message: string, statusCode = 400): SyncSubmitError => ({
  status: "error",
  statusCode,
  body: {
    error: {
      code,
      message,
    },
  },
});

const withEntries = async (
  runtime: SyncSubmitRuntime,
  baseVersionstamp: string | undefined,
): Promise<{ entries: OutboxEntry[]; lastVersionstamp?: string }> => {
  const entries = await runtime.listOutboxEntries(baseVersionstamp);
  const lastVersionstamp =
    entries.length > 0 ? entries[entries.length - 1]?.versionstamp : undefined;
  return { entries, lastVersionstamp };
};

export const submitSyncRequest = async (
  raw: unknown,
  runtime: SyncSubmitRuntime,
): Promise<SyncSubmitResult> => {
  if (!isObject(raw)) {
    return buildError("INVALID_REQUEST", "Request body must be an object.");
  }

  const requestId = raw["requestId"];
  if (!isNonEmptyString(requestId)) {
    return buildError("INVALID_REQUEST", "requestId is required.");
  }

  const adapterIdentity = raw["adapterIdentity"];
  if (!isNonEmptyString(adapterIdentity)) {
    return buildError("INVALID_REQUEST", "adapterIdentity is required.");
  }

  const conflictResolutionStrategy = raw["conflictResolutionStrategy"];
  if (
    !isNonEmptyString(conflictResolutionStrategy) ||
    !VALID_CONFLICT_RESOLUTION.has(conflictResolutionStrategy as "server" | "disabled")
  ) {
    return buildError(
      "INVALID_REQUEST",
      'conflictResolutionStrategy must be "server" or "disabled".',
    );
  }

  const baseVersionstamp = raw["baseVersionstamp"];
  if (baseVersionstamp !== undefined && !isNonEmptyString(baseVersionstamp)) {
    return buildError("INVALID_REQUEST", "baseVersionstamp must be a non-empty string.");
  }

  const normalizedBaseVersionstamp =
    baseVersionstamp !== undefined ? normalizeVersionstamp(baseVersionstamp) : undefined;
  if (normalizedBaseVersionstamp && !isValidVersionstamp(normalizedBaseVersionstamp)) {
    return buildError("INVALID_VERSIONSTAMP", "baseVersionstamp must be 24 hex characters.");
  }

  const commands = raw["commands"];
  if (!Array.isArray(commands)) {
    return buildError("INVALID_REQUEST", "commands must be an array.");
  }

  const expectedAdapterIdentity = await runtime.getAdapterIdentity();
  if (expectedAdapterIdentity !== adapterIdentity) {
    return buildError(
      "ADAPTER_IDENTITY_MISMATCH",
      "adapterIdentity does not match this adapter.",
      409,
    );
  }

  const existing = await runtime.getSyncRequest(requestId);
  if (existing) {
    const { entries, lastVersionstamp } = await withEntries(runtime, normalizedBaseVersionstamp);
    const response: SubmitResponse = {
      status: "conflict",
      requestId,
      confirmedCommandIds: existing.confirmedCommandIds ?? [],
      conflictCommandId: existing.conflictCommandId ?? undefined,
      lastVersionstamp: lastVersionstamp ?? existing.lastVersionstamp ?? undefined,
      entries,
      reason: "already_handled",
    };
    return { status: "ok", response };
  }

  const maxCommands = runtime.maxCommandsPerSubmit ?? DEFAULT_MAX_COMMANDS_PER_SUBMIT;
  const maxUnseen = runtime.maxUnseenMutations ?? DEFAULT_MAX_UNSEEN_MUTATIONS;

  if (commands.length === 0) {
    const { entries, lastVersionstamp } = await withEntries(runtime, normalizedBaseVersionstamp);
    const response: SubmitResponse = {
      status: "conflict",
      requestId,
      confirmedCommandIds: [],
      entries,
      lastVersionstamp,
      reason: "no_commands",
    };
    await runtime.storeSyncRequest({
      requestId,
      status: "conflict",
      confirmedCommandIds: [],
      baseVersionstamp: normalizedBaseVersionstamp,
      lastVersionstamp,
    });
    return { status: "ok", response };
  }

  if (commands.length > maxCommands) {
    const { entries, lastVersionstamp } = await withEntries(runtime, normalizedBaseVersionstamp);
    const response: SubmitResponse = {
      status: "conflict",
      requestId,
      confirmedCommandIds: [],
      entries,
      lastVersionstamp,
      reason: "limit_exceeded",
    };
    await runtime.storeSyncRequest({
      requestId,
      status: "conflict",
      confirmedCommandIds: [],
      baseVersionstamp: normalizedBaseVersionstamp,
      lastVersionstamp,
    });
    return { status: "ok", response };
  }

  const unseenCount = await runtime.countOutboxMutations(normalizedBaseVersionstamp);
  if (unseenCount > maxUnseen) {
    const { entries, lastVersionstamp } = await withEntries(runtime, normalizedBaseVersionstamp);
    const response: SubmitResponse = {
      status: "conflict",
      requestId,
      confirmedCommandIds: [],
      entries,
      lastVersionstamp,
      reason: "client_far_behind",
    };
    await runtime.storeSyncRequest({
      requestId,
      status: "conflict",
      confirmedCommandIds: [],
      baseVersionstamp: normalizedBaseVersionstamp,
      lastVersionstamp,
    });
    return { status: "ok", response };
  }

  const confirmedCommandIds: string[] = [];
  let conflictCommandId: string | undefined;
  let conflictReason: SubmitConflictReason | undefined;

  for (const command of commands) {
    if (!isObject(command)) {
      return buildError("INVALID_COMMAND", "Command entries must be objects.");
    }

    const commandId = command["id"];
    const commandName = command["name"];
    const target = command["target"];

    if (!isNonEmptyString(commandId) || !isNonEmptyString(commandName) || !isObject(target)) {
      return buildError("INVALID_COMMAND", "Command entries must include id, name, and target.");
    }

    const fragmentName = target["fragment"];
    const schemaName = target["schema"];

    if (!isNonEmptyString(fragmentName) || !isNonEmptyString(schemaName)) {
      return buildError("INVALID_COMMAND", "Command target must include fragment and schema.");
    }

    const resolved = runtime.resolveCommand(fragmentName, schemaName, commandName);
    if (!resolved) {
      return buildError("UNKNOWN_COMMAND", "Command target or name was not recognized.");
    }

    const ctx = runtime.createCommandContext(resolved.command);

    try {
      await runtime.executeCommand(resolved.command, command["input"], ctx);
      confirmedCommandIds.push(commandId);
    } catch (error) {
      if (error instanceof ConcurrencyConflictError) {
        conflictCommandId = commandId;
        conflictReason = "write_congestion";
        break;
      }
      await runtime.storeSyncRequest({
        requestId,
        status: "conflict",
        confirmedCommandIds,
        conflictCommandId: commandId,
        baseVersionstamp: normalizedBaseVersionstamp,
      });
      return {
        status: "error",
        statusCode: 500,
        body: {
          error: {
            code: "SYNC_COMMAND_FAILED",
            message: error instanceof Error ? error.message : "Sync command failed.",
          },
        },
      };
    }
  }

  const { entries, lastVersionstamp } = await withEntries(runtime, normalizedBaseVersionstamp);

  if (conflictReason) {
    const response: SubmitResponse = {
      status: "conflict",
      requestId,
      confirmedCommandIds,
      conflictCommandId,
      entries,
      lastVersionstamp,
      reason: conflictReason,
    };

    await runtime.storeSyncRequest({
      requestId,
      status: "conflict",
      confirmedCommandIds,
      conflictCommandId,
      baseVersionstamp: normalizedBaseVersionstamp,
      lastVersionstamp,
    });

    return { status: "ok", response };
  }

  const response: SubmitResponse = {
    status: "applied",
    requestId,
    confirmedCommandIds,
    entries,
    lastVersionstamp,
  };

  await runtime.storeSyncRequest({
    requestId,
    status: "applied",
    confirmedCommandIds,
    baseVersionstamp: normalizedBaseVersionstamp,
    lastVersionstamp,
  });

  return { status: "ok", response };
};
