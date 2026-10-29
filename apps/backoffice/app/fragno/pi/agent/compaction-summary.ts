/** Pi wraps a compaction's summary in model-facing framing; only the summary itself is worth reading. */
export function piCompactionSummary(text: string) {
  return /<summary>\n([\s\S]*)\n<\/summary>$/.exec(text)?.[1] ?? text;
}
