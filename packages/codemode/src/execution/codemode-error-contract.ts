import { z } from "zod";

/** Explicit, bounded diagnostic labels; arbitrary Error properties, stacks, and causes stay local. */
export const codemodeErrorMetadataSchema = z
  .record(z.string().min(1).max(128), z.string().max(4096))
  .refine((value) => Object.keys(value).length <= 16);

export const codemodeWireErrorSchema = z.strictObject({
  kind: z.enum(["error", "non-retryable", "event-timeout", "interrupted"]),
  name: z.string().max(1024),
  message: z.string().max(32_768),
  details: z
    .strictObject({ status: z.number().int().min(100).max(599), code: z.string().min(1).max(1024) })
    .nullable(),
  metadata: codemodeErrorMetadataSchema.nullable(),
});
export type CodemodeWireError = z.infer<typeof codemodeWireErrorSchema>;
