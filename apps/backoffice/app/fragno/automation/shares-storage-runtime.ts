import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  SHARED_MOUNT_POINT,
  type AcceptedShare,
  type Share,
  type SharedContents,
} from "@fragno-dev/backoffice-api/v0/shares";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type ShareServiceContext = DatabaseServiceContext<Record<string, never>>;

type ShareRow = {
  id: { externalId: string };
  kind: string;
  path: string;
  target: BackofficeRoutableScope;
  createdAt: Date;
};

type AcceptedShareRow = {
  id: { externalId: string };
  name: string;
  source: BackofficeRoutableScope;
  kind: string;
  path: string;
  createdAt: Date;
};

/** Accepting refuses a name this scope already reads another share under. */
export type AcceptShareOutcome =
  | { ok: true; share: AcceptedShare }
  | { ok: false; reason: "name-taken" };

/** Rows hold what a share opens as its kind and the folder or prefix, which only this file writes. */
function sharedContentsFromRow(row: { kind: string; path: string }): SharedContents {
  return row.kind === "blobs"
    ? { kind: "blobs", prefix: row.path }
    : { kind: "folder", path: row.path };
}

function sharedContentsToRow(contents: SharedContents): { kind: string; path: string } {
  return contents.kind === "blobs"
    ? { kind: "blobs", path: contents.prefix }
    : { kind: "folder", path: contents.path };
}

function shareFromRow(row: ShareRow): Share {
  return {
    shareId: row.id.externalId,
    of: sharedContentsFromRow(row),
    with: row.target,
    sharedAt: row.createdAt.toISOString(),
  };
}

function acceptedShareFromRow(row: AcceptedShareRow): AcceptedShare {
  return {
    shareId: row.id.externalId,
    name: row.name,
    from: row.source,
    of: sharedContentsFromRow(row),
    path: `${SHARED_MOUNT_POINT}/${row.name}/`,
    acceptedAt: row.createdAt.toISOString(),
  };
}

export const createShareServices = (
  defineService: <TService>(service: TService & ThisType<ShareServiceContext>) => TService,
) =>
  defineService({
    createShare({
      shareId,
      of,
      target,
    }: {
      shareId: string;
      of: SharedContents;
      target: BackofficeRoutableScope;
    }) {
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }): Share => {
          const createdAt = new Date();
          const row = { id: shareId, ...sharedContentsToRow(of), target, createdAt };
          uow.create("file_share", row);
          return shareFromRow({ ...row, id: { externalId: shareId } });
        })
        .build();
    },

    getShare({ shareId }: { shareId: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("file_share", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", shareId)),
          ),
        )
        .transformRetrieve(([row]) => (row ? shareFromRow(row) : null))
        .build();
    },

    listShares() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("file_share", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(shareFromRow))
        .build();
    },

    /** Returns whether the share existed. */
    deleteShare({ shareId }: { shareId: string }) {
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
    acceptShare({
      shareId,
      name,
      source,
      of,
    }: {
      shareId: string;
      name: string;
      source: BackofficeRoutableScope;
      of: SharedContents;
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
        .mutate(({ uow, retrieveResult: [existing, named] }): AcceptShareOutcome => {
          if (existing) {
            return { ok: true, share: acceptedShareFromRow(existing) };
          }
          if (named) {
            return { ok: false, reason: "name-taken" };
          }
          const row = {
            id: shareId,
            name,
            source,
            ...sharedContentsToRow(of),
            createdAt: new Date(),
          };
          // A concurrent acceptance of the share, or of another under the name, runs this again,
          // which answers as for an acceptance already made.
          uow.create("accepted_file_share", row, {
            retryOnUniqueConflict: ({ error }) => error.kind === "unique",
          });
          return { ok: true, share: acceptedShareFromRow({ ...row, id: { externalId: shareId } }) };
        })
        .build();
    },

    /** The share this scope reads at /shared/<name>/. */
    getAcceptedShareByName({ name }: { name: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("accepted_file_share", (b) =>
            b.whereIndex("idx_accepted_file_share_name", (eb) => eb("name", "=", name)),
          ),
        )
        .transformRetrieve(([row]) => (row ? acceptedShareFromRow(row) : null))
        .build();
    },

    listAcceptedShares() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("accepted_file_share", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(acceptedShareFromRow))
        .build();
    },

    /** Returns whether this scope had accepted the share. */
    deleteAcceptedShare({ shareId }: { shareId: string }) {
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
