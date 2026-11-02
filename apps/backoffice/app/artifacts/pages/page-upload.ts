import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import { getUploadReplica } from "@/fragno/upload/lofi/replica";
import type { PageUploadSource } from "@/routes/backoffice/pages/load.server";

/** The scope's Upload replica as a page reads it: open, or why it cannot be. */
type PageUpload =
  | { kind: "none" }
  | { kind: "open"; replica: LofiSqliteClient }
  | { kind: "unavailable"; message: string };

const pageUploads = new WeakMap<Promise<PageUploadSource>, Promise<PageUpload>>();

/**
 * Opens the Upload replica the loader named. Never rejects: a connection can fail after the loader
 * looked the backend up, such as when it was replaced, and that is the page's to show, not the
 * layout's. One promise per loader value, so use() can read it across renders.
 */
export function openPageUpload(upload: Promise<PageUploadSource>): Promise<PageUpload> {
  const opened = pageUploads.get(upload);
  if (opened !== undefined) {
    return opened;
  }
  const opening = upload
    .then(async (source): Promise<PageUpload> => {
      switch (source.kind) {
        case "none":
        case "unavailable":
          return source;
        case "ready":
          return { kind: "open", replica: await getUploadReplica(source.source) };
        default:
          throw new Error("Unsupported Upload source.", { cause: source satisfies never });
      }
    })
    .catch(
      (error: unknown): PageUpload => ({
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  pageUploads.set(upload, opening);
  return opening;
}
