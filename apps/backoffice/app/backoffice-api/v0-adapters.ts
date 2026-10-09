import type { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";

import { base64ToBytes, bytesToBase64 } from "@/lib/base64";

import type { RuntimeToolAdapters } from "./runtime-tool-handlers";

/**
 * Byte-oriented tools exchange base64 over HTTP while Codemode keeps raw `Uint8Array`s.
 *
 * TODO: Replace these base64 adapters with proper file transfer APIs (streamed uploads and
 * downloads) so large files do not pass through JSON bodies.
 */
export const backofficeApiV0Adapters: RuntimeToolAdapters<typeof backofficeApiV0> = {
  "state.readFileBytes": async (input, runTool) =>
    // The tool's output schema has already parsed this as bytes.
    bytesToBase64((await runTool(input)) as Uint8Array),
  "state.writeFileBytes": async ({ path, content }, runTool) =>
    await runTool({ path, content: base64ToBytes(content) }),
  "state.appendFile": async ({ path, content, encoding }, runTool) =>
    await runTool({ path, content: encoding === "base64" ? base64ToBytes(content) : content }),
  // The API never requests the `bytes` encoding, so the tool's result already fits the operation.
  "upload.prepared.read": async (input, runTool) => await runTool(input),
};
