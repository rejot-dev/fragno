import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

// pi-durable's harness cuts tool output beyond its defaults and drops the rest; it does not export
// them. Output within them reaches the model whole.
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
// Room for the notice around the beginning and end, so the harness never cuts an excerpt.
const NOTICE_BYTES = 1024;
const NOTICE_LINES = 8;

export type CodemodeOutput = { text: string; fullOutputPath: string | null };

/**
 * The model sees output within the harness limits whole. Longer output is saved to `path` and the
 * model sees its beginning and end, where the logs start and the error or result ends.
 */
export async function fitCodemodeOutput({
  text,
  fullText,
  path,
  state,
}: {
  text: string;
  /** The same output with readable JSON, for the saved file and its excerpt. */
  fullText: () => string;
  path: string;
  state: BackofficeStateBackend;
}): Promise<CodemodeOutput> {
  const fits =
    boundOutput(text, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES, retain: "head" })
      .droppedBytes === 0;
  if (fits) {
    return { text, fullOutputPath: null };
  }

  const full = fullText();
  const half = {
    maxBytes: (MAX_OUTPUT_BYTES - NOTICE_BYTES) / 2,
    maxLines: (MAX_OUTPUT_LINES - NOTICE_LINES) / 2,
  };
  const head = boundOutput(full, { ...half, retain: "head" });
  const tail = boundOutput(full, { ...half, retain: "tail" });
  const totalBytes = utf8ByteLength(full);
  const omittedBytes = totalBytes - head.bytes - tail.bytes;
  const saved = await saveFullOutput({ text: full, path, state });

  return {
    text: [
      `Output truncated: ${full.split("\n").length} lines, ${formatSize(totalBytes)}. Showing its beginning and end.`,
      "",
      head.text.trimEnd(),
      `… ${formatSize(omittedBytes)} omitted …`,
      tail.text.trimEnd(),
      "",
      saved.error === null
        ? `Full output: ${path}. Search or read parts of it with state in codemode.`
        : `Could not save the full output: ${saved.error}`,
    ].join("\n"),
    fullOutputPath: saved.error === null ? path : null,
  };
}

// A failed write must not discard the result of a program whose mutations already ran.
async function saveFullOutput({
  text,
  path,
  state,
}: {
  text: string;
  path: string;
  state: BackofficeStateBackend;
}): Promise<{ error: string | null }> {
  try {
    await state.writeFile(path, text);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
