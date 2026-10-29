import {
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  lofiSqliteReadViews,
  type LofiSqliteClient,
  type LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { useMemo } from "react";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { getWorkerReplica } from "@/fragno/lofi/browser-replica";
import { useLofiView } from "@/fragno/lofi/use-lofi-view";

import type { UploadFileRecord } from "../file-record";
import type { uploadReads } from "./replica-host";
import { UPLOAD_READ_VIEWS, UPLOAD_REPLICA_SCHEMAS } from "./replica-schemas";

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

const uploadReadView = lofiSqliteReadViews<typeof uploadReads>(UPLOAD_READ_VIEWS);

/** A live view of the files that finished uploading and were not deleted. */
export function readyUploadFilesView(replica: LofiSqliteClient) {
  return uploadReadView(replica, "readyFiles", undefined);
}

/** The ready files, as the replica changes. */
export function useReadyUploadFiles(
  replica: LofiSqliteClient,
): LofiSqliteViewResult<UploadFileRecord[]> {
  return useLofiView(useMemo(() => readyUploadFilesView(replica), [replica]));
}
