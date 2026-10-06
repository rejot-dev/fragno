import { serialize } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";

/** Measures Cap'n Web's encoded data, including escaping, before reserving or sending an RPC frame. */
export function assertCodemodeRpcPayloadSize(value: unknown): void {
  const bytes = new TextEncoder().encode(serialize(value)).byteLength;
  if (bytes > CODEMODE_LIMITS.maxRpcPayloadBytes) {
    throw new Error(
      `CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED: serialized payload is ${bytes} bytes; maximum is ${CODEMODE_LIMITS.maxRpcPayloadBytes}. Reduce the module or use a native Worker Loader.`,
    );
  }
}
