import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  LofiSqliteClient,
  LofiSqliteView,
  LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { uploadSchema } from "@fragno-dev/upload/schema";
import { useMemo } from "react";

import { lofiZql } from "@fragno-dev/lofi-zql";

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

/** A live view of the files that finished uploading and were not deleted, of one provider or all. */
export function readyUploadFilesView(replica: LofiSqliteClient, provider: string | null) {
  const upload = lofiZql(replica, uploadSchema);
  const ready = upload.query.file.where("status", "ready");
  return upload.store(provider === null ? ready : ready.where("provider", provider));
}

type ReadyUploadFileRow =
  ReturnType<typeof readyUploadFilesView> extends LofiSqliteView<readonly (infer TRow)[]>
    ? TRow
    : never;

/** Replica rows hold timestamps as epoch milliseconds. */
export function toUploadFileRecord(row: ReadyUploadFileRow): UploadFileRecord {
  return {
    provider: row.provider,
    fileKey: row.key,
    status: row.status,
    uploaderId: row.uploaderId,
    sizeBytes: row.sizeBytes,
    filename: row.filename,
    contentType: row.contentType,
    checksum: row.checksum,
    tags: row.tags === null ? undefined : [...row.tags],
    metadata: row.metadata,
    visibility: row.visibility,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt),
  };
}

/** The ready files of one provider, or of all of them, as the replica changes. */
export function useReadyUploadFiles(
  replica: LofiSqliteClient,
  provider: string | null,
): LofiSqliteViewResult<UploadFileRecord[]> {
  const result = useLofiView(
    useMemo(() => readyUploadFilesView(replica, provider), [replica, provider]),
  );
  return useMemo(
    () =>
      result.status === "ready"
        ? { status: "ready", data: result.data.map(toUploadFileRecord) }
        : result,
    [result],
  );
}
