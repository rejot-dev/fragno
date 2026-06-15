export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

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

export const SYSTEM_BACKOFFICE_PRINCIPAL: BackofficePrincipal = {
  type: "system",
  id: "system",
};
