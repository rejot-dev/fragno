import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export { uploadSchema } from "./schema";
export type { FileKeyEncoded, FileKeyPart, FileKeyParts } from "./keys";
export { decodeFileKey, encodeFileKey, encodeFileKeyPrefix } from "./keys";

export function createUploadFragmentClients(_config: FragnoPublicClientConfig = {}) {
  return {} as const;
}
