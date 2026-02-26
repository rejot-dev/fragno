import type { AnySchema, AnyTable, FragnoId } from "../schema/create";
import type { MutationOperation } from "../query/unit-of-work/unit-of-work";

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
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string;
      values: Record<string, unknown>;
    }
  | {
      op: "upsert";
      schema: string;
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string;
      values: Record<string, unknown>;
    }
  | {
      op: "update";
      schema: string;
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

export type OutboxRefLookup = {
  key: string;
  internalId: bigint | number;
  table: AnyTable;
  namespace?: string;
};

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
