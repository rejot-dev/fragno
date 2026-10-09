import { z } from "zod";

/**
 * Bytes travel inside JSON as standard base64.
 *
 * TODO: Replace base64 byte transport with proper file transfer APIs (streamed uploads and
 * downloads) so large files do not pass through JSON bodies.
 */
export const base64BytesSchema = z
  .base64()
  .meta({ id: "Base64Bytes", description: "Bytes encoded as standard base64." });
