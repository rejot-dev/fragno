import { Buffer } from "node:buffer";

import { projectConnectorNamedConnectionSchema } from "@fragno-dev/project-connector-fragment/contracts";
import { z } from "zod";

const connectorAddressSchema = z.union([
  z.tuple([z.literal("account"), z.string().min(1)]),
  z.tuple([
    z.literal("named"),
    projectConnectorNamedConnectionSchema.shape.projectId,
    projectConnectorNamedConnectionSchema.shape.providerConfigId,
    projectConnectorNamedConnectionSchema.shape.connectionName,
  ]),
]);
const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Encodes source selectors losslessly, packing only canonical lowercase UUIDs into binary. */
export function encodeConnectorConnectionId(
  address: z.output<typeof connectorAddressSchema>,
): string {
  let uuidFlags = 0;
  const components = address.slice(1).map((component, index) => {
    if (canonicalUuidPattern.test(component)) {
      uuidFlags |= 1 << index;
      return Buffer.from(component.replaceAll("-", ""), "hex");
    }
    // JSON strings preserve lone UTF-16 surrogates and escape NUL, leaving a safe binary delimiter.
    return Buffer.from(`${JSON.stringify(component)}\0`, "utf8");
  });
  const payload = Buffer.concat([Buffer.from([uuidFlags]), ...components]).toString("base64url");
  return `connector#${address[0] === "named" ? "n_" : "a_"}${payload}`;
}

/** Decodes canonical local addresses; encoded identities never supply user scope or authority. */
export function decodeConnectorConnectionLocalId(localId: string) {
  try {
    if (!/^(?:n_|a_)[A-Za-z0-9_-]+$/.test(localId)) {
      throw new Error("Invalid address encoding");
    }
    const kind = localId.startsWith("n_") ? "named" : "account";
    const payload = Buffer.from(localId.slice(2), "base64url");
    if (payload.length === 0) {
      throw new Error("Missing address payload");
    }
    const uuidFlags = payload.readUInt8(0);
    const components: unknown[] = [];
    let offset = 1;
    for (let index = 0; index < (kind === "named" ? 3 : 1); index++) {
      if (uuidFlags & (1 << index)) {
        if (offset + 16 > payload.length) {
          throw new Error("Truncated UUID component");
        }
        const hex = payload.subarray(offset, offset + 16).toString("hex");
        components.push(
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
        offset += 16;
      } else {
        const end = payload.indexOf(0, offset);
        if (end === -1) {
          throw new Error("Unterminated address component");
        }
        components.push(JSON.parse(payload.subarray(offset, end).toString("utf8")));
        offset = end + 1;
      }
    }
    if (offset !== payload.length) {
      throw new Error("Unexpected address data");
    }
    const address = connectorAddressSchema.parse([kind, ...components]);
    // Reject padding, alternate JSON/UTF-8 spellings, unused flags, and nonzero base64 pad bits.
    if (encodeConnectorConnectionId(address) !== `connector#${localId}`) {
      throw new Error("Noncanonical address");
    }
    return address;
  } catch {
    throw new Error("Connector integration connection ID is invalid.");
  }
}
