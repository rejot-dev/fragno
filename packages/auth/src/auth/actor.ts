import type { AuthActor, AuthPrincipal } from "./types";

export const toAuthActor = (principal: AuthPrincipal): AuthActor => ({
  userId: principal.user.id,
  email: principal.user.email,
  role: principal.user.role,
  activeOrganizationId: principal.auth.activeOrganizationId,
});
