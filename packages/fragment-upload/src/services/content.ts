import { UploadServiceError } from "./errors";

/**
 * Names the `storage_object` row for one write of a file. Every write gets its own row, so content
 * prepared for a batch never touches the content the file publishes until the batch commits.
 */
export function newObjectKey(provider: string, fileKey: string): string {
  return `${provider}/${fileKey}/${crypto.randomUUID()}`;
}

/** Rejects content larger than the largest file; `name` says whose content it is. */
export function assertFileSize(sizeBytes: number, maxFileBytes: number, name: string): void {
  if (sizeBytes > maxFileBytes) {
    throw new UploadServiceError(
      "FILE_TOO_LARGE",
      `${name} is ${sizeBytes} bytes; files may be at most ${maxFileBytes} bytes.`,
    );
  }
}

/** Reads a request body, rejecting it as soon as it outgrows the largest file. */
export async function readContent(
  body: ReadableStream<Uint8Array>,
  maxFileBytes: number,
  name: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for await (const chunk of body) {
    sizeBytes += chunk.byteLength;
    assertFileSize(sizeBytes, maxFileBytes, name);
    chunks.push(chunk);
  }
  const content = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}
