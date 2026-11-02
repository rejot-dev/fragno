import {
  type BackofficeRoutableScope,
  backofficeContextScopesEqual,
  backofficeScopeRootOwner,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedShare, Share, SharedContents } from "@fragno-dev/backoffice-api/v0/shares";

import type { AutomationsCommands } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRootOwnerResolver } from "@/backoffice-runtime/resolved-scope";

export type ShareRuntime = {
  create(input: { of: SharedContents; with: BackofficeRoutableScope }): Promise<Share>;
  accept(input: {
    from: BackofficeRoutableScope;
    shareId: string;
    name?: string;
  }): Promise<AcceptedShare>;
  list(): Promise<{ shared: Share[]; accepted: AcceptedShare[] }>;
  revoke(input: { shareId: string }): Promise<void>;
};

type ShareAutomations = Pick<
  AutomationsCommands,
  | "createShare"
  | "getShare"
  | "listShares"
  | "deleteShare"
  | "acceptShare"
  | "getAcceptedShareByName"
  | "listAcceptedShares"
  | "deleteAcceptedShare"
  | "resolveProjectForExecution"
>;

const WORKSPACE_ROOT = "/workspace/";

/** Slash-separated segments, none empty, `.`, or `..`, without control characters or wildcards. */
function isFolderLike(segments: string): boolean {
  for (let index = 0; index < segments.length; index += 1) {
    const code = segments.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || "*?\\".includes(segments[index])) {
      return false;
    }
  }
  return segments
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A share opens one /workspace folder, or the blobs under one folder-like key prefix, so what it
 * opens is everything below it and nothing beside it.
 */
function sharedContents(of: SharedContents): SharedContents {
  if (of.kind === "folder") {
    const folder = of.path.endsWith("/") ? of.path : `${of.path}/`;
    if (
      !folder.startsWith(WORKSPACE_ROOT) ||
      !isFolderLike(folder.slice(WORKSPACE_ROOT.length, -1))
    ) {
      throw new BackofficeOperationError(
        "invalid_request",
        "Shares name a /workspace folder, such as /workspace/reports/, without wildcards or traversal segments.",
      );
    }
    return { kind: "folder", path: folder };
  }
  const prefix = of.prefix.endsWith("/") ? of.prefix : `${of.prefix}/`;
  if (!isFolderLike(prefix.slice(0, -1))) {
    throw new BackofficeOperationError(
      "invalid_request",
      "Shares name a blob key prefix of whole segments, such as calls/2026/, without wildcards or traversal segments.",
    );
  }
  return { kind: "blobs", prefix };
}

/**
 * Shares between this scope and others. The sharing scope keeps the share, which is the only thing
 * that opens its folder or blobs to the other scope; accepting records in the other scope where to
 * look, so each side writes only its own scope, within its own credential's ceiling.
 */
export function createShareRuntime({
  scope,
  automationsFor,
  resolveRootOwner,
}: {
  scope: BackofficeRoutableScope;
  automationsFor: (scope: BackofficeRoutableScope) => ShareAutomations;
  resolveRootOwner: BackofficeRootOwnerResolver;
}): ShareRuntime {
  const automations = () => automationsFor(scope);

  /**
   * Callers name organizations and users by ID; Auth knows their jurisdiction. A project is
   * stored with its owner, so a share can never name one nobody could accept it in.
   */
  async function existingScope(named: BackofficeRoutableScope): Promise<BackofficeRoutableScope> {
    const owner = backofficeScopeRootOwner(named);
    const resolved = owner && (await resolveRootOwner(owner));
    const target =
      resolved &&
      mapBackofficeScopeNames(named, {
        organization: ({ orgId }) => ({ orgId, jurisdiction: resolved.jurisdiction }),
        user: ({ userId }) => ({ userId, jurisdiction: resolved.jurisdiction }),
        project: ({ projectId }) => ({ projectId }),
      });
    if (
      !target ||
      (target.kind === "project" &&
        !(await automationsFor(target.owner).resolveProjectForExecution({
          projectId: target.projectId,
        })))
    ) {
      throw new BackofficeOperationError("not_found", "The named scope does not exist.");
    }
    return target;
  }

  return {
    async create(input) {
      const of = sharedContents(input.of);
      const target = await existingScope(input.with);
      if (backofficeContextScopesEqual(target, scope)) {
        throw new BackofficeOperationError(
          "invalid_request",
          "A scope reads its own folders and blobs; share them with another scope.",
        );
      }
      return await automations().createShare({ shareId: crypto.randomUUID(), of, target });
    },

    async accept({ from, shareId, name = shareId }) {
      const source = await existingScope(from);
      const share = await automationsFor(source).getShare({ shareId });
      if (!share || !backofficeContextScopesEqual(share.with, scope)) {
        throw new BackofficeOperationError(
          "not_found",
          `That scope shares nothing with this one as ${shareId}.`,
        );
      }
      const accepted = await automations().acceptShare({ shareId, name, source, of: share.of });
      if (!accepted.ok) {
        throw new BackofficeOperationError(
          "conflict",
          `This scope already reads another share as ${name}: accept this one under another name.`,
        );
      }
      return accepted.share;
    },

    async list() {
      const [shared, accepted] = await Promise.all([
        automations().listShares(),
        automations().listAcceptedShares(),
      ]);
      return { shared, accepted };
    },

    async revoke({ shareId }) {
      const [revoked, left] = await Promise.all([
        automations().deleteShare({ shareId }),
        automations().deleteAcceptedShare({ shareId }),
      ]);
      if (!revoked && !left) {
        throw new BackofficeOperationError(
          "not_found",
          `This scope neither shared nor accepted ${shareId}.`,
        );
      }
    },
  };
}

/**
 * The shares `scope` accepted. The sharing scope's share is the authority: this scope reads through
 * it only while it stands and names this scope, whatever this scope's own record says, and asks
 * again on every use, so revoking takes effect at once.
 */
export function createAcceptedShares({
  scope,
  automationsFor,
}: {
  scope: BackofficeRoutableScope;
  automationsFor: (
    scope: BackofficeRoutableScope,
  ) => Pick<ShareAutomations, "getShare" | "getAcceptedShareByName" | "listAcceptedShares">;
}) {
  /** What the share opens while it stands and names this scope, as the sharing scope says. */
  async function standing(accepted: AcceptedShare): Promise<SharedContents | null> {
    const share = await automationsFor(accepted.from).getShare({ shareId: accepted.shareId });
    return share && backofficeContextScopesEqual(share.with, scope) ? share.of : null;
  }

  return {
    async list(): Promise<AcceptedShare[]> {
      return await automationsFor(scope).listAcceptedShares();
    },
    async find(name: string): Promise<AcceptedShare | null> {
      return await automationsFor(scope).getAcceptedShareByName({ name });
    },
    /** The shared folder while the share stands, or null. */
    async openFolder(
      accepted: AcceptedShare,
    ): Promise<{ from: BackofficeRoutableScope; path: string } | null> {
      const of = await standing(accepted);
      return of?.kind === "folder" ? { from: accepted.from, path: of.path } : null;
    },
    /** The shared blobs' prefix while the share stands, or null. */
    async openBlobs(
      accepted: AcceptedShare,
    ): Promise<{ from: BackofficeRoutableScope; prefix: string } | null> {
      const of = await standing(accepted);
      return of?.kind === "blobs" ? { from: accepted.from, prefix: of.prefix } : null;
    },
  };
}

export type AcceptedShares = ReturnType<typeof createAcceptedShares>;
