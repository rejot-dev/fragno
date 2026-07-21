import superjson, { type SuperJSONResult } from "superjson";

import { dbNow } from "../query/db-now";
import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import type { AnySchema, AnyTable, FragnoId } from "../schema/create";

export type OutboxConfig = {
  enabled: boolean;
  shouldInclude?: (operation: MutationOperation<AnySchema>) => boolean;
};

export type OutboxVersionstampStrategy =
  | "update-returning"
  | "insert-on-conflict-returning"
  | "insert-on-duplicate-last-insert-id";

export type OutboxPayload = {
  version: 1;
  mutations: OutboxMutation[];
};

export type OutboxMutation =
  | {
      op: "create";
      schema: string;
      schemaName?: string;
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string;
      values: Record<string, unknown>;
    }
  | {
      op: "update";
      schema: string;
      schemaName?: string;
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string;
      set: Record<string, unknown>;
      checkVersion?: number;
    }
  | {
      op: "delete";
      schema: string;
      schemaName?: string;
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string;
      checkVersion?: number;
    };

export type OutboxRefMap = Record<string, string>;

export type OutboxPayloadSerialized = {
  json: unknown;
  meta?: Record<string, unknown>;
};

export type OutboxEntry = {
  id: FragnoId;
  versionstamp: string;
  uowId: string;
  payload: OutboxPayloadSerialized;
  refMap?: OutboxRefMap;
  createdAt: Date;
};

export type OutboxStreamEntry = {
  id: { externalId: string; internalId?: string };
  versionstamp: string;
  uowId: string;
  payload: OutboxPayload;
  refMap?: OutboxRefMap;
  createdAt: Date;
};

export type OutboxRefLookup = {
  key: string;
  internalId: bigint | number;
  table: AnyTable;
  namespace?: string;
};

/**
 * Builds the complete visible row values represented by an outbox create mutation.
 * Runtime defaults must already be present so their generated value is shared with the database write.
 */
export function materializeOutboxCreateValues(
  table: AnyTable,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const materialized: Record<string, unknown> = {};

  for (const [columnName, column] of Object.entries(table.columns)) {
    if (column.isHidden || column.role === "external-id") {
      continue;
    }

    const suppliedValue = values[columnName];
    if (suppliedValue !== undefined) {
      materialized[columnName] = suppliedValue;
      continue;
    }

    if (column.default && "value" in column.default) {
      materialized[columnName] = column.default.value;
      continue;
    }

    if (column.default && "dbSpecial" in column.default && column.default.dbSpecial === "now") {
      materialized[columnName] = dbNow();
      continue;
    }

    if (column.isNullable) {
      materialized[columnName] = null;
      continue;
    }

    throw new Error(`Outbox create is missing required column ${table.name}.${columnName}.`);
  }

  return materialized;
}

const OUTBOX_VERSIONSTAMP_REGEX = /^[0-9a-f]{24}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidOutboxStreamEntry = (path: string, message: string): never => {
  throw new Error(`Invalid Fragno outbox stream entry at ${path}: ${message}`);
};

const parseString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string => {
  const value = record[key];
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    return invalidOutboxStreamEntry(
      path,
      options.allowEmpty ? "expected a string" : "expected a non-empty string",
    );
  }
  return value;
};

const parseOptionalString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return invalidOutboxStreamEntry(path, "expected a non-empty string when present");
  }
  return value;
};

const parseVersionstamp = (record: Record<string, unknown>, path: string): string => {
  const versionstamp = parseString(record, "versionstamp", path);
  if (!OUTBOX_VERSIONSTAMP_REGEX.test(versionstamp)) {
    return invalidOutboxStreamEntry(path, "expected 24 lowercase hexadecimal characters");
  }
  return versionstamp;
};

const parseMutationValues = (
  record: Record<string, unknown>,
  key: "values" | "set",
  path: string,
): Record<string, unknown> => {
  const values = record[key];
  if (!isRecord(values)) {
    return invalidOutboxStreamEntry(path, "expected an object");
  }
  return values;
};

const parseCheckVersion = (record: Record<string, unknown>, path: string): number | undefined => {
  const checkVersion = record["checkVersion"];
  if (checkVersion === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(checkVersion) || (checkVersion as number) < 0) {
    return invalidOutboxStreamEntry(path, "expected a non-negative safe integer");
  }
  return checkVersion as number;
};

const parseOutboxMutation = (value: unknown, index: number): OutboxMutation => {
  const path = `payload.mutations[${index}]`;
  if (!isRecord(value)) {
    return invalidOutboxStreamEntry(path, "expected an object");
  }

  const op = value["op"];
  if (op !== "create" && op !== "update" && op !== "delete") {
    return invalidOutboxStreamEntry(`${path}.op`, "expected create, update, or delete");
  }

  const shared = {
    schema: parseString(value, "schema", `${path}.schema`, { allowEmpty: true }),
    schemaName: parseOptionalString(value, "schemaName", `${path}.schemaName`),
    namespace: parseOptionalString(value, "namespace", `${path}.namespace`),
    table: parseString(value, "table", `${path}.table`),
    externalId: parseString(value, "externalId", `${path}.externalId`),
    versionstamp: parseVersionstamp(value, `${path}.versionstamp`),
  };

  if (op === "create") {
    return {
      op,
      ...shared,
      values: parseMutationValues(value, "values", `${path}.values`),
    };
  }

  const checkVersion = parseCheckVersion(value, `${path}.checkVersion`);
  if (op === "update") {
    return {
      op,
      ...shared,
      set: parseMutationValues(value, "set", `${path}.set`),
      ...(checkVersion === undefined ? {} : { checkVersion }),
    };
  }

  return {
    op,
    ...shared,
    ...(checkVersion === undefined ? {} : { checkVersion }),
  };
};

const parseOutboxPayload = (value: unknown): OutboxPayload => {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["mutations"])) {
    return invalidOutboxStreamEntry("payload", "expected a version 1 payload with mutations");
  }
  return {
    version: 1,
    mutations: value["mutations"].map(parseOutboxMutation),
  };
};

const deserializeOutboxPayload = (value: unknown): OutboxPayload => {
  if (!isRecord(value) || !("json" in value)) {
    return invalidOutboxStreamEntry("payload", "expected a SuperJSON result");
  }
  if (value["meta"] !== undefined && !isRecord(value["meta"])) {
    return invalidOutboxStreamEntry("payload.meta", "expected an object when present");
  }

  try {
    return parseOutboxPayload(superjson.deserialize(value as unknown as SuperJSONResult));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid Fragno outbox stream entry")) {
      throw error;
    }
    throw new Error("Invalid Fragno outbox stream entry at payload: SuperJSON decoding failed", {
      cause: error,
    });
  }
};

const parseRefMap = (value: unknown): OutboxRefMap | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return invalidOutboxStreamEntry("refMap", "expected an object when present");
  }

  const refMap: OutboxRefMap = {};
  for (const [key, externalId] of Object.entries(value)) {
    if (typeof externalId !== "string" || externalId.length === 0) {
      return invalidOutboxStreamEntry(`refMap.${key}`, "expected a non-empty string");
    }
    refMap[key] = externalId;
  }
  return refMap;
};

export function parseOutboxStreamEntry(value: unknown): OutboxStreamEntry {
  if (!isRecord(value)) {
    return invalidOutboxStreamEntry("entry", "expected an object");
  }

  const id = value["id"];
  if (!isRecord(id)) {
    return invalidOutboxStreamEntry("id", "expected an object");
  }

  const createdAtValue = parseString(value, "createdAt", "createdAt");
  const createdAt = new Date(createdAtValue);
  if (Number.isNaN(createdAt.getTime())) {
    return invalidOutboxStreamEntry("createdAt", "expected an ISO-8601 timestamp");
  }

  const internalId = parseOptionalString(id, "internalId", "id.internalId");
  return {
    id: {
      externalId: parseString(id, "externalId", "id.externalId"),
      ...(internalId === undefined ? {} : { internalId }),
    },
    versionstamp: parseVersionstamp(value, "versionstamp"),
    uowId: parseString(value, "uowId", "uowId"),
    payload: deserializeOutboxPayload(value["payload"]),
    refMap: parseRefMap(value["refMap"]),
    createdAt,
  };
}

export function encodeVersionstamp(transactionVersion: bigint, userVersion: number): Uint8Array {
  if (userVersion < 0 || userVersion > 0xffff) {
    throw new Error(`Invalid outbox user version: ${userVersion}`);
  }

  const txBytes = bigintToBytes(transactionVersion, 10);
  const userBytes = new Uint8Array(2);
  userBytes[0] = (userVersion >> 8) & 0xff;
  userBytes[1] = userVersion & 0xff;

  const combined = new Uint8Array(12);
  combined.set(txBytes, 0);
  combined.set(userBytes, 10);

  return combined;
}

export function versionstampToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToVersionstamp(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid versionstamp hex length: ${hex.length}`);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function parseOutboxVersionValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string") {
    return BigInt(value);
  }

  throw new Error(`Invalid outbox version value: ${String(value)}`);
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;

  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  if (remaining !== 0n) {
    throw new Error(`Outbox version ${value} exceeds ${length * 8} bits`);
  }

  return bytes;
}
