import {
  lofiSqliteTableName,
  quoteSqliteIdentifier,
  type LofiSqliteReader,
} from "@fragno-dev/lofi/sqlite";
import { readViewEngine } from "@fragno-dev/lofi/sqlite/worker";
import { uploadSchema } from "@fragno-dev/upload/schema";

import type { UploadFileRecord } from "../file-record";
import { UPLOAD_READ_VIEWS, UPLOAD_REPLICA_SCHEMAS } from "./replica-schemas";

const { columns } = uploadSchema.tables.file;
const READY_FILE_COLUMNS = {
  key: columns.key,
  status: columns.status,
  uploaderId: columns.uploaderId,
  // A bigint column, which file records hold as a number.
  sizeBytes: "integer",
  filename: columns.filename,
  contentType: columns.contentType,
  checksum: columns.checksum,
  tags: columns.tags,
  metadata: columns.metadata,
  visibility: columns.visibility,
  createdAt: columns.createdAt,
  updatedAt: columns.updatedAt,
  deletedAt: columns.deletedAt,
} as const;
const READY_FILES_SQL = `SELECT ${Object.keys(READY_FILE_COLUMNS).map(quoteSqliteIdentifier).join(", ")} FROM ${quoteSqliteIdentifier(lofiSqliteTableName({ schema: uploadSchema }, "file"))} WHERE "status" = 'ready'`;

/** The files that finished uploading and were not deleted. */
function readReadyUploadFiles(reader: LofiSqliteReader): UploadFileRecord[] {
  return reader
    .query({ sql: READY_FILES_SQL, params: [], columns: READY_FILE_COLUMNS })
    .map(({ key, tags, ...row }) => ({ ...row, fileKey: key, tags: tags ?? undefined }));
}

/** The reads pages ask the Upload replica worker for by name, with `uploadReadView`. */
export const uploadReads = {
  readyFiles: readReadyUploadFiles,
};

/** What an Upload replica worker serves, in a browser tab and in scenario tests. */
export const uploadReplicaHost = {
  schemas: UPLOAD_REPLICA_SCHEMAS,
  localSchemas: [],
  projections: [],
  ephemeralTables: [],
  engines: [readViewEngine({ kind: UPLOAD_READ_VIEWS, reads: uploadReads })],
};
