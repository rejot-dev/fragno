import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
  type BackofficePrincipal,
} from "@/backoffice-runtime/context";

import { createPermissionDeniedFileSystemError } from "./fs-errors";
import { normalizeAbsolutePath } from "./normalize-path";

export type FileSubject =
  | { kind: "root" }
  | { kind: "user"; userId: string }
  | { kind: "automation"; automationId: string; scope: BackofficeContextScope }
  | { kind: "object"; objectType: string; objectId: string; scope: BackofficeContextScope };

export type FileGroup =
  | { kind: "root" }
  | { kind: "user"; userId: string }
  | { kind: "org"; orgId: string };

export type FilePrincipal = {
  subject: FileSubject;
  primaryGroup: FileGroup;
  groups: FileGroup[];
};

export type FileNodePermissions = {
  owner: FileSubject;
  group: FileGroup;
  mode: number;
};

export const ROOT_FILE_PRINCIPAL: FilePrincipal = {
  subject: { kind: "root" },
  primaryGroup: { kind: "root" },
  groups: [{ kind: "root" }],
};

export const ROOT_FILE_NODE_PERMISSIONS: FileNodePermissions = {
  owner: ROOT_FILE_PRINCIPAL.subject,
  group: ROOT_FILE_PRINCIPAL.primaryGroup,
  mode: 0o755,
};

export const sameFileSubject = (left: FileSubject, right: FileSubject): boolean => {
  switch (left.kind) {
    case "root":
      return right.kind === "root";
    case "user":
      return right.kind === "user" && left.userId === right.userId;
    case "automation":
      return (
        right.kind === "automation" &&
        left.automationId === right.automationId &&
        backofficeContextScopesEqual(left.scope, right.scope)
      );
    case "object":
      return (
        right.kind === "object" &&
        left.objectType === right.objectType &&
        left.objectId === right.objectId &&
        backofficeContextScopesEqual(left.scope, right.scope)
      );
  }
};

export const sameFileGroup = (left: FileGroup, right: FileGroup): boolean => {
  switch (left.kind) {
    case "root":
      return right.kind === "root";
    case "user":
      return right.kind === "user" && left.userId === right.userId;
    case "org":
      return right.kind === "org" && left.orgId === right.orgId;
  }
};

export const isRootFilePrincipal = (principal: FilePrincipal): boolean =>
  principal.subject.kind === "root";

export const getScopePrimaryFileGroup = (scope: BackofficeContextScope): FileGroup => {
  switch (scope.kind) {
    case "system":
      return { kind: "root" };
    case "org":
      return { kind: "org", orgId: scope.orgId };
    case "user":
      return { kind: "user", userId: scope.userId };
    case "project":
      return { kind: "org", orgId: scope.orgId };
  }
};

export const resolveActorFilePrincipal = ({
  actor,
  scope,
}: {
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
}): FilePrincipal => {
  if (actor.type === "system") {
    const primaryGroup = getScopePrimaryFileGroup(scope);
    return {
      subject: ROOT_FILE_PRINCIPAL.subject,
      primaryGroup,
      groups: sameFileGroup(primaryGroup, ROOT_FILE_PRINCIPAL.primaryGroup)
        ? [ROOT_FILE_PRINCIPAL.primaryGroup]
        : [ROOT_FILE_PRINCIPAL.primaryGroup, primaryGroup],
    };
  }

  if (actor.type === "user") {
    const userGroup: FileGroup = { kind: "user", userId: actor.userId };
    if (scope.kind === "org") {
      const orgGroup: FileGroup = { kind: "org", orgId: scope.orgId };
      return {
        subject: { kind: "user", userId: actor.userId },
        primaryGroup: orgGroup,
        groups: [orgGroup, userGroup],
      };
    }

    return {
      subject: { kind: "user", userId: actor.userId },
      primaryGroup: userGroup,
      groups: [userGroup],
    };
  }

  const primaryGroup = getScopePrimaryFileGroup(scope);
  if (actor.type === "automation") {
    return {
      subject: { kind: "automation", automationId: actor.id, scope },
      primaryGroup,
      groups: [primaryGroup],
    };
  }

  return {
    subject: { kind: "object", objectType: "backoffice-object", objectId: actor.id, scope },
    primaryGroup,
    groups: [primaryGroup],
  };
};

export const hasFileWritePermission = (
  principal: FilePrincipal,
  node: FileNodePermissions,
): boolean => {
  if (isRootFilePrincipal(principal)) {
    return true;
  }

  const normalizedMode = node.mode & 0o7777;
  const selectedBits = sameFileSubject(principal.subject, node.owner)
    ? (normalizedMode >> 6) & 0o7
    : principal.groups.some((group) => sameFileGroup(group, node.group))
      ? (normalizedMode >> 3) & 0o7
      : normalizedMode & 0o7;

  return (selectedBits & 0o2) === 0o2;
};

export const assertFileWritable = ({
  principal,
  node,
  operation,
  path,
}: {
  principal: FilePrincipal;
  node: FileNodePermissions;
  operation: string;
  path: string;
}): void => {
  if (!hasFileWritePermission(principal, node)) {
    throw createPermissionDeniedFileSystemError(operation, normalizeAbsolutePath(path));
  }
};

export const assertFileOwnerOrRoot = ({
  principal,
  node,
  operation,
  path,
}: {
  principal: FilePrincipal;
  node: FileNodePermissions;
  operation: string;
  path: string;
}): void => {
  if (!isRootFilePrincipal(principal) && !sameFileSubject(principal.subject, node.owner)) {
    throw createPermissionDeniedFileSystemError(operation, normalizeAbsolutePath(path));
  }
};

export const assertRootFilePrincipal = ({
  principal,
  operation,
  path,
}: {
  principal: FilePrincipal;
  operation: string;
  path: string;
}): void => {
  if (!isRootFilePrincipal(principal)) {
    throw createPermissionDeniedFileSystemError(operation, normalizeAbsolutePath(path));
  }
};
