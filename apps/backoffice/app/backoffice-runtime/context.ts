export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

export type BackofficePrincipal =
  | {
      type: "user";
      id: string;
      userId: string;
      email?: string | null;
      role?: string | null;
      activeOrganizationId?: string | null;
      organizationIds: string[];
    }
  | { type: "system"; id: string; organizationIds?: string[] }
  | { type: "automation"; id: string; userId?: string; organizationIds?: string[] }
  | { type: "object"; id: string; organizationIds?: string[] };

export type BackofficeExecutionContext = {
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
};

export const backofficeContextScopesEqual = (
  left: BackofficeContextScope,
  right: BackofficeContextScope,
): boolean => {
  switch (left.kind) {
    case "system":
      return right.kind === "system";
    case "org":
      return right.kind === "org" && left.orgId === right.orgId;
    case "user":
      return right.kind === "user" && left.userId === right.userId;
    case "project":
      return (
        right.kind === "project" && left.orgId === right.orgId && left.projectId === right.projectId
      );
  }
};
