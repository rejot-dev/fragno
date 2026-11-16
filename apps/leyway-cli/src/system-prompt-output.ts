import { writeFile } from "node:fs/promises";

export type BackofficeSystemPromptDestination =
  | { kind: "stdout" }
  | { kind: "file"; outputFile: string };

/** Writes a system prompt to stdout or creates an owner-only output file. */
export async function writeBackofficeSystemPrompt({
  systemPrompt,
  outputFile,
  writeStdout,
}: {
  systemPrompt: string;
  outputFile: string | null;
  writeStdout: (content: string) => void;
}): Promise<BackofficeSystemPromptDestination> {
  if (outputFile === null) {
    writeStdout(systemPrompt);
    return { kind: "stdout" };
  }

  await writeFile(outputFile, systemPrompt, { flag: "wx", mode: 0o600 });
  return { kind: "file", outputFile };
}
