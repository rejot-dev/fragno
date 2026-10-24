import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { LofiZqlClient, LofiZqlResult, LofiZqlView } from "@fragno-dev/lofi/zql";
import { uploadSchema } from "@fragno-dev/upload/schema";
import { useMemo } from "react";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getWorkerReplica } from "@/fragno/lofi/browser-replica";
import { useLofiZql } from "@/fragno/lofi/use-lofi-zql";

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
export function getUploadReplica(source: UploadReplicaSource): Promise<LofiZqlClient> {
  const description = describeUploadReplicaSource(source);
  return getWorkerReplica({
    baseUrl: description.baseUrl,
    resourceKey: description.resourceKey,
    schemas: UPLOAD_REPLICA_SCHEMAS,
    startWorker: (baseUrl) =>
      new Worker(new URL("./replica.worker.ts", import.meta.url), {
        type: "module",
        name: baseUrl,
      }),
  });
}

/** A live view of the files that finished uploading and were not deleted, of one provider or all. */
export function readyUploadFilesView(replica: LofiZqlClient, provider: string | null) {
  const upload = replica.forSchema(uploadSchema);
  const ready = upload.query.file.where("status", "ready");
  return upload.store(provider === null ? ready : ready.where("provider", provider));
}

type ReadyUploadFileRow =
  ReturnType<typeof readyUploadFilesView> extends LofiZqlView<readonly (infer TRow)[]>
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
  replica: LofiZqlClient,
  provider: string | null,
): LofiZqlResult<UploadFileRecord[]> {
  const result = useLofiZql(
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
