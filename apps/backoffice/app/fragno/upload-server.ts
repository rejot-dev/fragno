import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";
import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";

import { createUploadFragment } from "@fragno-dev/upload";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import { inferFileContentType } from "@/file-collection/file-content-type";

// Sandbox pushes write into the shared workspace without preconditions, so one archive stays sized
// for task outputs rather than whole projects.
const FILE_LINK_MAX_ARCHIVE_WRITE_FILES = 200;
const FILE_LINK_MAX_ARCHIVE_WRITE_BYTES = 25 * 1024 * 1024;

export function createUploadServer({
  runtime,
  fileLinkSigning,
}: {
  runtime: BackofficeFragmentRuntimeOptions;
  fileLinkSigning: { secret: string; audience: string };
}): ReturnType<typeof createUploadFragment> {
  const databaseAdapter = runtime.adapters.createAdapter({ kind: "upload" });

  return createUploadFragment(
    {
      maxFileBytes: STATE_FILE_MAX_BYTES,
      fileLinks: {
        ...fileLinkSigning,
        contentTypeForKey: inferFileContentType,
        maxArchiveWriteFiles: FILE_LINK_MAX_ARCHIVE_WRITE_FILES,
        maxArchiveWriteBytes: FILE_LINK_MAX_ARCHIVE_WRITE_BYTES,
      },
      textIndex: { enabled: true },
    },
    {
      databaseAdapter,
      mountRoute: "/api/upload",
      outbox: { enabled: true, tables: ["file"] },
    },
  );
}

export type UploadFragment = ReturnType<typeof createUploadServer>;

export type UploadRouteCaller = RouteCallerForFragment<UploadFragment>;

export const createUploadRouteCaller = (
  object: FetchCommands,
  request?: Request,
): UploadRouteCaller =>
  createRouteCaller<UploadFragment>({
    baseUrl: request?.url ?? "https://upload.internal",
    mountRoute: "/api/upload",
    baseHeaders: request?.headers,
    fetch: (routeRequest) => object.fetch(routeRequest),
  });
