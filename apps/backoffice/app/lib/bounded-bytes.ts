/**
 * Reads a byte stream whole unless it holds more than `maxBytes`, and returns null when it does. A
 * declared size over the limit cancels the stream unread; an absent or wrong one is caught while
 * counting, so the limit holds either way.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("A byte limit must be a nonnegative safe integer.");
  }
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await body.cancel();
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
