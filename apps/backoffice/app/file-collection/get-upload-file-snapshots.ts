import type { UploadFileSnapshot } from "@fragno-dev/upload/types";

import type { UploadRouteCaller } from "@/fragno/upload-server";

/** Batch file snapshots include deleted rows and revisions; missing keys are omitted. */
export async function getUploadFileSnapshots({
  routes,
  fileKeys,
}: {
  routes: UploadRouteCaller;
  fileKeys: readonly string[];
}): Promise<UploadFileSnapshot[]> {
  if (fileKeys.length === 0) {
    return [];
  }
  const response = await routes("POST", "/files/snapshots", {
    body: { fileKeys: [...fileKeys] },
  });
  if (response.type === "error") {
    throw new Error(`Upload file snapshot lookup failed: ${response.error.message}`);
  }
  if (response.type !== "json") {
    throw new Error(
      `Upload file snapshot lookup returned an unexpected ${response.type} response.`,
    );
  }
  return response.data.files;
}
