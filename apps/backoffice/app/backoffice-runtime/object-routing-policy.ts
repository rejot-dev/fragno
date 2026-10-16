import type { AutomationEvent, AutomationEventSubject } from "@fragno-dev/backoffice-api/v0/events";
import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeObjectAddress, BackofficeObjectBindingName } from "./object-registry";
import { org, project, singleton, user } from "./object-registry";

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
};

const subjectField = (subject: AutomationEventSubject | null | undefined, field: string) =>
  subject ? normalizeId(subject[field]) : null;

const objectAddress = (
  binding: BackofficeObjectBindingName,
  scope: BackofficeObjectAddress["scope"],
): BackofficeObjectAddress => ({
  binding,
  scope,
});

export const resolveEventOrgId = (event: AutomationEvent): string => {
  const organization = backofficeScopeOrganization(event.scope);
  if (!organization) {
    throw new Error(`Cannot route automation event ${event.id}: expected org-backed scope.`);
  }

  const subjectOrgId = subjectField(event.subject, "orgId");
  if (subjectOrgId && organization.orgId !== subjectOrgId) {
    throw new Error(
      `Cannot route automation event ${event.id}: event org id ${organization.orgId} does not match subject org id ${subjectOrgId}.`,
    );
  }

  return organization.orgId;
};

export const resolveOrgScopedObjectAddress = (
  binding: BackofficeObjectBindingName,
  event: AutomationEvent,
): BackofficeObjectAddress => objectAddress(binding, org(resolveEventOrgId(event)));

export const resolveUserScopedObjectAddress = (
  binding: BackofficeObjectBindingName,
  event: AutomationEvent,
): BackofficeObjectAddress => {
  const userId = subjectField(event.subject, "userId");
  if (!userId) {
    throw new Error(`Cannot route automation event ${event.id}: missing subject user id.`);
  }

  return objectAddress(binding, user({ userId }));
};

export const resolveProjectScopedObjectAddress = (
  binding: BackofficeObjectBindingName,
  event: AutomationEvent,
): BackofficeObjectAddress => {
  const projectId = subjectField(event.subject, "projectId");
  if (!projectId) {
    throw new Error(`Cannot route automation event ${event.id}: missing subject project id.`);
  }

  return objectAddress(binding, project({ orgId: resolveEventOrgId(event), projectId }));
};

export const resolveSingletonObjectAddress = (
  binding: BackofficeObjectBindingName,
): BackofficeObjectAddress => objectAddress(binding, singleton());
