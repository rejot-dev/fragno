import type { AutomationEvent, AutomationEventSubject } from "@/fragno/automation";

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
  const eventOrgId = normalizeId(event.orgId);
  const subjectOrgId = subjectField(event.subject, "orgId");

  if (eventOrgId && subjectOrgId && eventOrgId !== subjectOrgId) {
    throw new Error(
      `Cannot route automation event ${event.id}: event org id ${eventOrgId} does not match subject org id ${subjectOrgId}.`,
    );
  }

  const orgId = subjectOrgId ?? eventOrgId;
  if (!orgId) {
    throw new Error(`Cannot route automation event ${event.id}: missing org id.`);
  }

  return orgId;
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

  return objectAddress(binding, project({ projectId }));
};

export const resolveSingletonObjectAddress = (
  binding: BackofficeObjectBindingName,
): BackofficeObjectAddress => objectAddress(binding, singleton());
