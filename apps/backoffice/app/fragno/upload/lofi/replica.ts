import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  lofiSqliteTableName,
  quoteSqliteIdentifier,
  type LofiSqliteClient,
  type LofiSqliteView,
  type LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { uploadSchema } from "@fragno-dev/upload/schema";
import { useMemo } from "react";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getWorkerReplica } from "@/fragno/lofi/browser-replica";
import { useLofiView } from "@/fragno/lofi/use-lofi-view";

import type { UploadFileRecord } from "../file-record";
import { UPLOAD_REPLICA_SCHEMAS } from "./replica-schemas";

/** A scope's Upload backend, named by the adapter identity the server last reported for it. */
export type UploadReplicaSource = {
  scope: BackofficeRoutableScope;
  adapterIdentity: string;
};

export function describeUploadReplicaSource(source: UploadReplicaSource) {
  const scopeKey = backofficeScopePathSegment(source.scope);
  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl: `/api/upload-scoped/${backofficeContextScopeRoutePath(source.scope)}`,
  };
}

/** The scope's Upload replica in this tab. */
export function getUploadReplica(source: UploadReplicaSource): Promise<LofiSqliteClient> {
  const description = describeUploadReplicaSource(source);
  return getWorkerReplica({
    target: { baseUrl: description.baseUrl, adapterIdentity: source.adapterIdentity },
    schemas: UPLOAD_REPLICA_SCHEMAS,
    startWorker: (name) =>
      new Worker(new URL("./replica.worker.ts", import.meta.url), { type: "module", name }),
  });
}

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

/** A live view of the files that finished uploading and were not deleted. */
export function readyUploadFilesView(replica: LofiSqliteClient) {
  return replica.sql({ sql: READY_FILES_SQL, params: [], columns: READY_FILE_COLUMNS });
}

type ReadyUploadFileRow =
  ReturnType<typeof readyUploadFilesView> extends LofiSqliteView<readonly (infer TRow)[]>
    ? TRow
    : never;

export function toUploadFileRecord(row: ReadyUploadFileRow): UploadFileRecord {
  return {
    fileKey: row.key,
    status: row.status,
    uploaderId: row.uploaderId,
    sizeBytes: row.sizeBytes,
    filename: row.filename,
    contentType: row.contentType,
    checksum: row.checksum,
    tags: row.tags ?? undefined,
    metadata: row.metadata,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** The ready files, as the replica changes. */
export function useReadyUploadFiles(
  replica: LofiSqliteClient,
): LofiSqliteViewResult<UploadFileRecord[]> {
  const result = useLofiView(useMemo(() => readyUploadFilesView(replica), [replica]));
  return useMemo(
    () =>
      result.status === "ready"
        ? { status: "ready", data: result.data.map(toUploadFileRecord) }
        : result,
    [result],
  );
}
