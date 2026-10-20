import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

/** The audio stays in the workspace; callers name the file rather than sending its bytes. */
export const reson8TranscribeInputSchema = z.object({
  path: z.string().trim().min(1).describe("Audio file in the workspace, e.g. /workspace/call.wav"),
  encoding: z
    .enum(["auto", "pcm_s16le"])
    .optional()
    .describe("pcm_s16le for raw PCM; auto detects containers such as WAV"),
  sampleRate: z.number().int().positive().optional().describe("Sample rate of raw PCM audio"),
  channels: z.number().int().positive().optional().describe("Channel count of raw PCM audio"),
  customModelId: z.string().trim().min(1).optional(),
  includeTimestamps: z.boolean().optional(),
  includeWords: z.boolean().optional(),
  includeConfidence: z.boolean().optional(),
});

const reson8WordSchema = z.object({
  text: z.string(),
  start_ms: z.number().optional(),
  duration_ms: z.number().optional(),
  confidence: z.number().optional(),
});

const reson8TranscriptionSchema = z.object({
  text: z.string(),
  start_ms: z.number().optional(),
  duration_ms: z.number().optional(),
  words: z.array(reson8WordSchema).optional(),
});

export const reson8Operations = {
  "reson8.prerecorded.transcribe": {
    description: "Transcribe a prerecorded audio file from the workspace with Reson8.",
    permissions: [BACKOFFICE_PERMISSION.reson8.transcribe, BACKOFFICE_PERMISSION.upload.read],
    input: reson8TranscribeInputSchema,
    output: reson8TranscriptionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
