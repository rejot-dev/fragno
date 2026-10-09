import type { AutomationExternalEntityRef } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  AUTOMATION_SOURCES,
  AUTOMATION_SOURCE_EVENT_TYPES,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type {
  AutomationEventTypeForSource,
  AutomationSource,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES };
export type { AutomationEventTypeForSource, AutomationSource };

export type AutomationEventIdentity = {
  source: string;
  eventType: string;
};

export type AutomationEntityDefinition<
  TScope extends "internal" | "external" = "internal" | "external",
  TType extends string = string,
> = {
  scope: TScope;
  type: TType;
  label: string;
  description?: string;
};

export type AutomationExternalEntityDefinition<
  TSource extends string = string,
  TType extends string = string,
> = AutomationEntityDefinition<"external", TType> & {
  source: TSource;
};

export function getAutomationEventIdentity(
  event: Pick<AutomationEvent, "source" | "eventType">,
): AutomationEventIdentity {
  return { source: event.source, eventType: event.eventType };
}

export type AutomationKnownEvent<S extends AutomationSource = AutomationSource> = Omit<
  AutomationEvent,
  "source" | "eventType"
> & {
  source: S;
  eventType: AutomationEventTypeForSource<S>;
};

export type AutomationCreateIdentityClaimInput = {
  scope: BackofficeContextScope;
  actor: AutomationExternalEntityRef;
  ttlMinutes?: number;
  event: AutomationEvent;
  idempotencyKey: string;
};

export type AutomationCreateIdentityClaimResult = {
  url: string;
  externalId: string;
  code: string;
  actor: AutomationExternalEntityRef;
  type?: string;
  expiresAt?: string;
};
