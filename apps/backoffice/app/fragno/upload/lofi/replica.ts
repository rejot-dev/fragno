import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { lofiSqliteTableName, type LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { uploadSchema } from "@fragno-dev/upload/schema";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getBrowserReplica } from "@/fragno/lofi/browser-replica";

import type { UploadFileRecord } from "../file-record";

/** A scope's Upload backend, named by the adapter identity the server last reported for it. */
export type UploadReplicaSource = {
  scope: BackofficeRoutableScope;
  adapterIdentity: string;
};

/** The Upload outbox carries only the `file` table, the metadata the file views list. */
export const UPLOAD_REPLICA_SCHEMAS = [{ schema: uploadSchema }];

export function describeUploadReplicaSource(source: UploadReplicaSource) {
  const scopeKey = backofficeScopePathSegment(source.scope);
  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl: `/api/upload-scoped/${backofficeContextScopeRoutePath(source.scope)}`,
  };
}

/** The scope's Upload replica in this tab. */
export function getUploadReplica(source: UploadReplicaSource): Promise<LofiSqliteReplica> {
  const description = describeUploadReplicaSource(source);
  return getBrowserReplica({
    name: "Upload",
    baseUrl: description.baseUrl,
    resourceKey: description.resourceKey,
    schemas: UPLOAD_REPLICA_SCHEMAS,
  });
}

const files = `"${lofiSqliteTableName({ schema: uploadSchema }, "file")}"`;
const file = uploadSchema.tables.file.columns;

/** Files that finished uploading and were not deleted, of one provider or of all of them. */
export async function readReadyUploadFiles(
  replica: LofiSqliteReplica,
  provider: string | null,
): Promise<UploadFileRecord[]> {
  const rows = await replica.query({
    sql: `SELECT "provider", "key", "status", "uploaderId", "sizeBytes", "filename", "contentType",
            "checksum", "tags", "metadata", "visibility", "createdAt", "updatedAt", "deletedAt"
          FROM ${files}
          WHERE "status" = 'ready' AND (?1 IS NULL OR "provider" = ?1)`,
    params: [provider],
    columns: {
      provider: file.provider,
      key: file.key,
      status: file.status,
      uploaderId: file.uploaderId,
      sizeBytes: "integer",
      filename: file.filename,
      contentType: file.contentType,
      checksum: file.checksum,
      tags: file.tags,
      metadata: file.metadata,
      visibility: file.visibility,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      deletedAt: file.deletedAt,
    },
  });
  return rows.map(({ key, tags, ...row }) => ({
    ...row,
    fileKey: key,
    tags: tags ?? undefined,
  }));
}
