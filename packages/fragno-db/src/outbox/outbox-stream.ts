import { FRAGNO_OUTBOX_PAGE_SIZE, type OutboxEntry } from "./outbox";

/** Wire projection; payload decoding belongs to the consumer that interprets mutations. */
export type OutboxStreamEntry = Pick<OutboxEntry, "versionstamp" | "uowId" | "payload" | "refMap">;

/** A caught-up marker covers a fixed response-start target, not the moving live tail. */
export type OutboxStreamFrame =
  | {
      type: "started";
      protocolVersion: 1;
      adapterIdentity: string;
      catchUpTargetVersionstamp: string | null;
      catchUpPageSize: number;
    }
  | { type: "entry"; entry: OutboxStreamEntry }
  | { type: "caught-up"; throughVersionstamp: string | null }
  | { type: "heartbeat" }
  | { type: "rotate"; reason: "lease-expired" };

/** Validates untrusted NDJSON frames without interpreting the serialized mutation payload. */
export function parseOutboxStreamFrame(value: unknown): OutboxStreamFrame {
  if (isRecord(value)) {
    switch (value["type"]) {
      case "started":
        if (
          value["protocolVersion"] === 1 &&
          typeof value["adapterIdentity"] === "string" &&
          value["adapterIdentity"].length > 0 &&
          isNullableVersionstamp(value["catchUpTargetVersionstamp"]) &&
          typeof value["catchUpPageSize"] === "number" &&
          Number.isInteger(value["catchUpPageSize"]) &&
          value["catchUpPageSize"] >= 1 &&
          value["catchUpPageSize"] <= FRAGNO_OUTBOX_PAGE_SIZE
        ) {
          return value as OutboxStreamFrame;
        }
        break;
      case "entry": {
        const entry = value["entry"];
        if (
          isRecord(entry) &&
          isVersionstamp(entry["versionstamp"]) &&
          typeof entry["uowId"] === "string" &&
          entry["uowId"].length > 0 &&
          isRecord(entry["payload"]) &&
          "json" in entry["payload"] &&
          (entry["payload"]["meta"] === undefined || isRecord(entry["payload"]["meta"])) &&
          (entry["refMap"] === undefined ||
            (isRecord(entry["refMap"]) &&
              Object.values(entry["refMap"]).every((reference) => typeof reference === "string")))
        ) {
          return value as OutboxStreamFrame;
        }
        break;
      }
      case "caught-up":
        if (isNullableVersionstamp(value["throughVersionstamp"])) {
          return value as OutboxStreamFrame;
        }
        break;
      case "heartbeat":
        return { type: "heartbeat" };
      case "rotate":
        if (value["reason"] === "lease-expired") {
          return { type: "rotate", reason: "lease-expired" };
        }
        break;
    }
  }
  throw new Error("Invalid Fragno outbox stream frame.");
}

function isVersionstamp(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/u.test(value);
}

function isNullableVersionstamp(value: unknown): value is string | null {
  return value === null || isVersionstamp(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
