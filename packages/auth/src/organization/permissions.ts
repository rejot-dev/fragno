import type { Role } from "../types";

export const OWNER_ROLE = "owner";
// Organization-scoped admin role (distinct from the global Role = "admin").
export const ADMIN_ROLE = "admin";

export const isGlobalAdmin = (role: Role) => role === "admin";

export const hasRole = (roles: readonly string[], role: string) => roles.includes(role);

export const canManageOrganization = (roles: readonly string[]) =>
  hasRole(roles, OWNER_ROLE) || hasRole(roles, ADMIN_ROLE);

export const canDeleteOrganization = (roles: readonly string[]) => hasRole(roles, OWNER_ROLE);
