import type { TestDb } from "@fragno-dev/test";
import { uploadSchema } from "@fragno-dev/upload";

/**
 * Arranges ready Upload metadata in one write for listing scenarios that cross the 500-row page.
 * Uploading each file over HTTP costs seconds while these scenarios only list metadata; their
 * content is never read. Upload itself is covered by scenarios that use the real upload route.
 */
export async function seedReadyUploadFiles(
  db: TestDb,
  input: { provider: string; fileKeys: readonly string[] },
): Promise<void> {
  const uow = db.createUnitOfWork("seed-ready-upload-files").forSchema(uploadSchema);
  const now = new Date();
  for (const fileKey of input.fileKeys) {
    uow.create("file", {
      key: fileKey,
      provider: input.provider,
      uploaderId: null,
      filename: fileKey.split("/").at(-1) ?? fileKey,
      sizeBytes: 0n,
      contentType: "text/plain",
      checksum: null,
      visibility: "private",
      tags: null,
      metadata: null,
      status: "ready",
      objectKey: `seeded/${input.provider}/${fileKey}`,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      deletedAt: null,
      errorCode: null,
      errorMessage: null,
    });
  }
  const { success } = await uow.executeMutations();
  if (!success) {
    throw new Error("Failed to seed ready Upload files.");
  }
}
