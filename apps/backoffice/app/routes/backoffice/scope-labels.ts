import type { BackofficeMeData } from "@/fragno/auth/contracts";

import type { AutomationProjectRecord } from "./automations/data";
import { toExternalId } from "./automations/data";

export const SYSTEM_SCOPE_LABEL = "System";

/** System scope belongs to global administrators, the role the auth directory stores on the user. */
export function isBackofficeSystemAdministrator(user: BackofficeMeData["user"]) {
  return user.role === "admin";
}

export function userScopeLabel(user: BackofficeMeData["user"]) {
  return user.email ?? user.id;
}

export function projectScopeLabel(project: AutomationProjectRecord) {
  return (
    project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project"
  );
}
