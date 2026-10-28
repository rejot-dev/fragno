import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  SHARED_MOUNT_POINT,
  type AcceptedFileShare,
  type FileShare,
} from "@fragno-dev/backoffice-api/v0/state";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type FileShareServiceContext = DatabaseServiceContext<Record<string, never>>;

type FileShareRow = {
  id: { externalId: string };
  path: string;
  target: BackofficeRoutableScope;
  createdAt: Date;
};

type AcceptedFileShareRow = {
  id: { externalId: string };
  name: string;
  source: BackofficeRoutableScope;
  path: string;
  createdAt: Date;
};

/** Accepting refuses a name this scope already mounts another share under. */
export type AcceptFileShareOutcome =
  | { ok: true; share: AcceptedFileShare }
  | { ok: false; reason: "name-taken" };

function fileShareFromRow(row: FileShareRow): FileShare {
  return {
    shareId: row.id.externalId,
    path: row.path,
    with: row.target,
    sharedAt: row.createdAt.toISOString(),
  };
}

function acceptedFileShareFromRow(row: AcceptedFileShareRow): AcceptedFileShare {
  return {
    shareId: row.id.externalId,
    name: row.name,
    from: row.source,
    path: `${SHARED_MOUNT_POINT}/${row.name}/`,
    sourcePath: row.path,
    acceptedAt: row.createdAt.toISOString(),
  };
}

export const createFileShareServices = (
  defineService: <TService>(service: TService & ThisType<FileShareServiceContext>) => TService,
) =>
  defineService({
    createFileShare({
      shareId,
      path,
      target,
    }: {
      shareId: string;
      path: string;
      target: BackofficeRoutableScope;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }): FileShare => {
          const createdAt = new Date();
          uow.create("file_share", { id: shareId, path, target, createdAt });
          return fileShareFromRow({ id: { externalId: shareId }, path, target, createdAt });
        })
        .build();
    },

    getFileShare({ shareId }: { shareId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("file_share", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", shareId)),
          ),
        )
        .transformRetrieve(([row]) => (row ? fileShareFromRow(row) : null))
        .build();
    },

    listFileShares() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("file_share", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(fileShareFromRow))
        .build();
    },

    /** Returns whether the share existed. */
    deleteFileShare({ shareId }: { shareId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("file_share", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", shareId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return false;
          }
          uow.delete("file_share", existing.id);
          return true;
        })
        .build();
    },

    /** Accepting a share this scope already accepted returns it under the name it has. */
    acceptFileShare({
      shareId,
      name,
      source,
      path,
    }: {
      shareId: string;
      name: string;
      source: BackofficeRoutableScope;
      path: string;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("accepted_file_share", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", shareId)),
            )
            .findFirst("accepted_file_share", (b) =>
              b.whereIndex("idx_accepted_file_share_name", (eb) => eb("name", "=", name)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existing, named] }): AcceptFileShareOutcome => {
          if (existing) {
            return { ok: true, share: acceptedFileShareFromRow(existing) };
          }
          if (named) {
            return { ok: false, reason: "name-taken" };
          }
          const createdAt = new Date();
          // A concurrent acceptance of the share, or of another under the name, runs this again,
          // which answers as for an acceptance already made.
          uow.create(
            "accepted_file_share",
            { id: shareId, name, source, path, createdAt },
            { retryOnUniqueConflict: ({ error }) => error.kind === "unique" },
          );
          return {
            ok: true,
            share: acceptedFileShareFromRow({
              id: { externalId: shareId },
              name,
              source,
              path,
              createdAt,
            }),
          };
        })
        .build();
    },

    /** The share this scope mounts as /shared/<name>/. */
    getAcceptedFileShareByName({ name }: { name: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("accepted_file_share", (b) =>
            b.whereIndex("idx_accepted_file_share_name", (eb) => eb("name", "=", name)),
          ),
        )
        .transformRetrieve(([row]) => (row ? acceptedFileShareFromRow(row) : null))
        .build();
    },

    listAcceptedFileShares() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("accepted_file_share", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(acceptedFileShareFromRow))
        .build();
    },

    /** Returns whether this scope had accepted the share. */
    deleteAcceptedFileShare({ shareId }: { shareId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("accepted_file_share", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", shareId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return false;
          }
          uow.delete("accepted_file_share", existing.id);
          return true;
        })
        .build();
    },
  });
