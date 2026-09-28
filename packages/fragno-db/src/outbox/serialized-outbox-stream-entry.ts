import type { SuperJSONResult } from "superjson";

import type { OutboxStreamEntry, SerializedOutboxStreamEntry } from "./outbox-stream";

type OutboxOperationMetadata = NonNullable<SuperJSONResult["meta"]>;
type ReferentialEqualities = NonNullable<OutboxOperationMetadata["referentialEqualities"]>;

const OUTBOX_MUTATION_PAYLOAD_PROPERTIES = new Set(["json", "meta"]);

function skipJsonWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function findJsonStringEnd(value: string, start: number): number {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === '"') {
      return index + 1;
    }
  }
  throw new Error("Serialized outbox JSON contains an unterminated string.");
}

function findJsonValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"') {
    return findJsonStringEnd(value, start);
  }
  if (first === "{" || first === "[") {
    const expectedClosings = [first === "{" ? "}" : "]"];
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === '"') {
        index = findJsonStringEnd(value, index) - 1;
        continue;
      }
      if (character === "{") {
        expectedClosings.push("}");
      } else if (character === "[") {
        expectedClosings.push("]");
      } else if (character === "}" || character === "]") {
        if (expectedClosings.pop() !== character) {
          throw new Error("Serialized outbox JSON contains a mismatched container.");
        }
        if (expectedClosings.length === 0) {
          return index + 1;
        }
      }
    }
    throw new Error("Serialized outbox JSON contains an unterminated container.");
  }

  let index = start;
  while (index < value.length && !/[\s,\]}]/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function splitJsonArrayElements(value: string): string[] {
  let index = skipJsonWhitespace(value, 0);
  if (value[index] !== "[") {
    throw new Error("Serialized outbox JSON array must start with '['.");
  }
  index = skipJsonWhitespace(value, index + 1);
  if (value[index] === "]") {
    return [];
  }

  const elements: string[] = [];
  while (index < value.length) {
    const end = findJsonValueEnd(value, index);
    elements.push(value.slice(index, end));
    index = skipJsonWhitespace(value, end);
    if (value[index] === "]") {
      return elements;
    }
    if (value[index] !== ",") {
      throw new Error("Serialized outbox JSON array elements must be comma-separated.");
    }
    index = skipJsonWhitespace(value, index + 1);
  }
  throw new Error("Serialized outbox JSON array is unterminated.");
}

function extractJsonObjectProperties(
  value: string,
  requestedProperties: ReadonlySet<string>,
): Map<string, string> {
  let index = skipJsonWhitespace(value, 0);
  if (value[index] !== "{") {
    throw new Error("Serialized outbox JSON object must start with '{'.");
  }
  index = skipJsonWhitespace(value, index + 1);
  const properties = new Map<string, string>();
  if (value[index] === "}") {
    return properties;
  }

  while (index < value.length) {
    if (value[index] !== '"') {
      throw new Error("Serialized outbox JSON object property must be a string.");
    }
    const keyEnd = findJsonStringEnd(value, index);
    const key = JSON.parse(value.slice(index, keyEnd)) as string;
    index = skipJsonWhitespace(value, keyEnd);
    if (value[index] !== ":") {
      throw new Error("Serialized outbox JSON object property must contain ':'.");
    }
    const propertyStart = skipJsonWhitespace(value, index + 1);
    const propertyEnd = findJsonValueEnd(value, propertyStart);
    if (requestedProperties.has(key)) {
      properties.set(key, value.slice(propertyStart, propertyEnd));
    }
    index = skipJsonWhitespace(value, propertyEnd);
    if (value[index] === "}") {
      return properties;
    }
    if (value[index] !== ",") {
      throw new Error("Serialized outbox JSON object properties must be comma-separated.");
    }
    index = skipJsonWhitespace(value, index + 1);
  }
  throw new Error("Serialized outbox JSON object is unterminated.");
}

function prefixOperationPath(operationIndex: number, path: string): string {
  const operationPath = `operations.${operationIndex}`;
  return path.length === 0 ? operationPath : `${operationPath}.${path}`;
}

function addReferentialEqualities(
  output: Record<string, string[]>,
  operationIndex: number,
  equalities: ReferentialEqualities,
): void {
  const addEntries = (entries: Record<string, string[]>): void => {
    for (const [representative, identicalPaths] of Object.entries(entries)) {
      output[prefixOperationPath(operationIndex, representative)] = identicalPaths.map((path) =>
        prefixOperationPath(operationIndex, path),
      );
    }
  };

  if (Array.isArray(equalities)) {
    const [rootEqualities, remainingEqualities] = equalities;
    output[prefixOperationPath(operationIndex, "")] = rootEqualities.map((path) =>
      prefixOperationPath(operationIndex, path),
    );
    if (remainingEqualities) {
      addEntries(remainingEqualities);
    }
    return;
  }

  addEntries(equalities);
}

function orderMutationPayloads(
  mutationPayloadsJson: string,
  mysqlOrdinalWrapped: boolean,
): string[] {
  const payloads = splitJsonArrayElements(mutationPayloadsJson);
  if (!mysqlOrdinalWrapped) {
    return payloads;
  }

  return payloads
    .map((item) => {
      const [ordinalJson, payloadJson] = splitJsonArrayElements(item);
      if (ordinalJson === undefined || payloadJson === undefined) {
        throw new Error("Serialized MySQL outbox mutation is missing its order or payload.");
      }
      return { ordinal: JSON.parse(ordinalJson) as number, payloadJson };
    })
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(({ payloadJson }) => payloadJson);
}

/** Assembles trusted mutation JSON without parsing and reconstructing operation payloads. */
export function assembleSerializedOutboxStreamEntry(input: {
  versionstamp: string;
  uowId: string;
  refMapJson: string | null;
  mutationPayloadsJson: string;
  mysqlOrdinalWrapped: boolean;
}): SerializedOutboxStreamEntry {
  const mutationPayloads = orderMutationPayloads(
    input.mutationPayloadsJson,
    input.mysqlOrdinalWrapped,
  );
  const operationJson: string[] = [];
  const values: Record<string, unknown> = {};
  const referentialEqualities: Record<string, string[]> = {};

  for (const [operationIndex, mutationPayload] of mutationPayloads.entries()) {
    const properties = extractJsonObjectProperties(
      mutationPayload,
      OUTBOX_MUTATION_PAYLOAD_PROPERTIES,
    );
    const serializedOperation = properties.get("json");
    if (serializedOperation === undefined) {
      throw new Error("Serialized outbox mutation payload is missing its json property.");
    }
    operationJson.push(serializedOperation);

    const serializedMetadata = properties.get("meta");
    if (serializedMetadata === undefined || serializedMetadata === "null") {
      continue;
    }
    const metadata = JSON.parse(serializedMetadata) as OutboxOperationMetadata;
    if (metadata.v !== 1) {
      throw new Error("Serialized outbox mutation metadata must use SuperJSON version 1.");
    }
    if (metadata.values !== undefined) {
      if (Array.isArray(metadata.values)) {
        throw new Error("Serialized outbox operation cannot have root value metadata.");
      }
      for (const [path, annotation] of Object.entries(metadata.values)) {
        values[prefixOperationPath(operationIndex, path)] = annotation;
      }
    }
    if (metadata.referentialEqualities !== undefined) {
      addReferentialEqualities(
        referentialEqualities,
        operationIndex,
        metadata.referentialEqualities,
      );
    }
  }

  const hasValues = Object.keys(values).length > 0;
  const hasReferentialEqualities = Object.keys(referentialEqualities).length > 0;
  const metadataJson =
    hasValues || hasReferentialEqualities
      ? `,"meta":${JSON.stringify({
          ...(hasValues ? { values } : {}),
          ...(hasReferentialEqualities ? { referentialEqualities } : {}),
          v: 1,
        })}`
      : "";
  const payloadJson = `{"json":{"version":2,"operations":[${operationJson.join(",")}]}${metadataJson}}`;
  const refMapProperty = input.refMapJson === null ? "" : `,"refMap":${input.refMapJson}`;

  return {
    versionstamp: input.versionstamp,
    entryJson:
      `{"versionstamp":${JSON.stringify(input.versionstamp)},` +
      `"uowId":${JSON.stringify(input.uowId)},` +
      `"payload":${payloadJson}${refMapProperty}}`,
  };
}

/** Serializes an in-memory entry into the same opaque representation used by SQL adapters. */
export function serializeOutboxStreamEntry(entry: OutboxStreamEntry): SerializedOutboxStreamEntry {
  const wireEntry: OutboxStreamEntry = {
    versionstamp: entry.versionstamp,
    uowId: entry.uowId,
    payload: entry.payload,
    ...(entry.refMap === undefined ? {} : { refMap: entry.refMap }),
  };
  return {
    versionstamp: wireEntry.versionstamp,
    entryJson: JSON.stringify(wireEntry),
  };
}
