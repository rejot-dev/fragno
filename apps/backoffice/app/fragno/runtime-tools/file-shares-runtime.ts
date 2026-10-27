import {
  type BackofficeRoutableScope,
  backofficeContextScopesEqual,
  backofficeScopeRootOwner,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedFileShare, FileShare } from "@fragno-dev/backoffice-api/v0/state";

import type { AutomationsCommands } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRootOwnerResolver } from "@/backoffice-runtime/resolved-scope";

export type FileShareRuntime = {
  share(input: { path: string; with: BackofficeRoutableScope }): Promise<FileShare>;
  accept(input: {
    from: BackofficeRoutableScope;
    shareId: string;
    name?: string;
  }): Promise<AcceptedFileShare>;
  list(): Promise<{ shared: FileShare[]; accepted: AcceptedFileShare[] }>;
  revoke(input: { shareId: string }): Promise<void>;
};

type ShareAutomations = Pick<
  AutomationsCommands,
  | "createFileShare"
  | "getFileShare"
  | "listFileShares"
  | "deleteFileShare"
  | "acceptFileShare"
  | "listAcceptedFileShares"
  | "deleteAcceptedFileShare"
>;

const WORKSPACE_ROOT = "/workspace/";

/** A share names one /workspace folder, so the files it opens are those below it. */
function sharedFolder(path: string): string {
  const folder = path.endsWith("/") ? path : `${path}/`;
  const segments = folder.slice(WORKSPACE_ROOT.length, -1).split("/");
  if (
    !folder.startsWith(WORKSPACE_ROOT) ||
    folder === WORKSPACE_ROOT ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[*?\\]/u.test(folder) ||
    folder.includes("\0")
  ) {
    throw new BackofficeOperationError(
      "invalid_request",
      "Shares name a /workspace folder, such as /workspace/reports/, without wildcards or traversal segments.",
    );
  }
  return folder;
}

/**
 * Shares between this scope and others. The sharing scope keeps the share, which is the only thing
 * that opens its folder to the other scope; accepting records in the other scope where to look, so
 * each side writes only its own scope, within its own credential's ceiling.
 */
export function createFileShareRuntime({
  scope,
  automationsFor,
  resolveRootOwner,
}: {
  scope: BackofficeRoutableScope;
  automationsFor: (scope: BackofficeRoutableScope) => ShareAutomations;
  resolveRootOwner: BackofficeRootOwnerResolver;
}): FileShareRuntime {
  const automations = () => automationsFor(scope);

  /** Callers name organizations and users by ID; Auth knows their jurisdiction. */
  async function existingScope(named: BackofficeRoutableScope): Promise<BackofficeRoutableScope> {
    const owner = backofficeScopeRootOwner(named);
    const resolved = owner && (await resolveRootOwner(owner));
    if (!resolved) {
      throw new BackofficeOperationError("not_found", "The named scope does not exist.");
    }
    return mapBackofficeScopeNames(named, {
      organization: ({ orgId }) => ({ orgId, jurisdiction: resolved.jurisdiction }),
      user: ({ userId }) => ({ userId, jurisdiction: resolved.jurisdiction }),
      project: ({ projectId }) => ({ projectId }),
    });
  }

  return {
    async share(input) {
      const path = sharedFolder(input.path);
      const target = await existingScope(input.with);
      if (backofficeContextScopesEqual(target, scope)) {
        throw new BackofficeOperationError(
          "invalid_request",
          "A scope reads its own folders in /workspace; share them with another scope.",
        );
      }
      return await automations().createFileShare({ shareId: crypto.randomUUID(), path, target });
    },

    async accept({ from, shareId, name = shareId }) {
      const source = await existingScope(from);
      const share = await automationsFor(source).getFileShare({ shareId });
      if (!share || !backofficeContextScopesEqual(share.with, scope)) {
        throw new BackofficeOperationError(
          "not_found",
          `That scope shares nothing with this one as ${shareId}.`,
        );
      }
      const accepted = await automations().acceptFileShare({
        shareId,
        name,
        source,
        path: share.path,
      });
      if (!accepted.ok) {
        throw new BackofficeOperationError(
          "conflict",
          `This scope already mounts another share as ${name}: accept this one under another name.`,
        );
      }
      return accepted.share;
    },

    async list() {
      const [shared, accepted] = await Promise.all([
        automations().listFileShares(),
        automations().listAcceptedFileShares(),
      ]);
      return { shared, accepted };
    },

    async revoke({ shareId }) {
      const [revoked, left] = await Promise.all([
        automations().deleteFileShare({ shareId }),
        automations().deleteAcceptedFileShare({ shareId }),
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
