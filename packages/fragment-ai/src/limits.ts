import type { AiFragmentConfig } from "./index";

const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

const estimateByteSize = (value: unknown) => {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "string") {
    return encoder.encode(value).length;
  }

  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return encoder.encode(String(value)).length;
  }
};

export const resolveMaxMessageBytes = (config: AiFragmentConfig) =>
  config.limits?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

export const resolveMaxArtifactBytes = (config: AiFragmentConfig) =>
  config.limits?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

export const estimateMessageSizeBytes = (content: unknown, text: string | null | undefined) =>
  estimateByteSize(content) + estimateByteSize(text ?? "");

export const estimateArtifactSizeBytes = (data: unknown, text: string | null | undefined) =>
  estimateByteSize(data) + estimateByteSize(text ?? "");
