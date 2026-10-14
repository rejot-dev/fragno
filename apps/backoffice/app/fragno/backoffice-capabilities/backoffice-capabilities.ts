import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { z } from "zod";

import type {
  BackofficeObjectBindingName,
  BackofficeObjectRegistry,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import type { AutomationExternalEntityDefinition } from "@/fragno/automation/contracts";
import type { DurableHookRepository } from "@/fragno/durable-hooks";
import { zodSchemaToJsonSchema } from "@/lib/zod/zod-formatter";

import { apiCapability } from "./capabilities/api";
import {
  AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
  AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  AUTH_AUTOMATION_SOURCE,
  authCapability,
} from "./capabilities/auth";
import { automationsCapability } from "./capabilities/automations";
import { codemodeCapability } from "./capabilities/codemode";
import {
  FORMS_AUTOMATION_EVENT_FORM_CREATED,
  FORMS_AUTOMATION_EVENT_FORM_DELETED,
  FORMS_AUTOMATION_EVENT_FORM_UPDATED,
  FORMS_AUTOMATION_EVENT_RESPONSE_SUBMITTED,
  FORMS_AUTOMATION_SOURCE,
  formsCapability,
} from "./capabilities/forms";
import { githubCapability } from "./capabilities/github";
import { integrationsCapability } from "./capabilities/integrations";
import { mcpCapability } from "./capabilities/mcp";
import { otpCapability } from "./capabilities/otp";
import { piCapability } from "./capabilities/pi";
import { connectorCapability } from "./capabilities/project-connector";
import { resendCapability } from "./capabilities/resend";
import { reson8Capability } from "./capabilities/reson8";
import { sandboxCapability } from "./capabilities/sandbox";
import { telegramCapability } from "./capabilities/telegram";
import { uploadCapability } from "./capabilities/upload";

export type BackofficeCapabilityKind = "connection" | "system";

export type BackofficeCapabilityId =
  | "api"
  | "automations"
  | "auth"
  | "codemode"
  | "forms"
  | "github"
  | "integrations"
  | "mcp"
  | "connector"
  | "otp"
  | "pi"
  | "resend"
  | "reson8"
  | "sandbox"
  | "telegram"
  | "upload";

export type ConnectionVerificationResult = {
  ok: boolean;
  message: string;
};

export type ConnectionStatus = {
  id: BackofficeCapabilityId;
  label: string;
  kind: BackofficeCapabilityKind;
  configured: boolean;
  config?: Record<string, unknown>;
  missing?: string[];
  nextSteps?: string[];
  verification?: ConnectionVerificationResult;
};

export type BackofficeCapabilityContext = {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  scope: BackofficeContextScope;
  orgId: string;
};

type BackofficeHookScope = {
  id: string;
  label: string;
  getRepository(
    input: BackofficeCapabilityContext,
  ): Promise<DurableHookRepository> | DurableHookRepository;
};

type BackofficeAutomationEventDescriptor = {
  source: string;
  eventType: string;
  label: string;
  description?: string;
  payloadSchema?: z.ZodType;
  actorSchema?: z.ZodType;
  subjectSchema?: z.ZodType;
  example?: unknown;
};

/** Declares a user-facing event producer independently from lifecycle events a capability emits. */
type CapabilityEventSourceContribution = {
  source: string;
  label: string;
  description: string;
};

/** Reports a connection capability's configuration for capabilities.list and hooks.scopes.list. */
type BackofficeConnectionDescriptor = {
  getStatus(input: BackofficeCapabilityContext): Promise<ConnectionStatus>;
};

/** Collects the independent product roles contributed by one Backoffice capability. */
type CapabilityContributions = {
  connection: BackofficeConnectionDescriptor | null;
  eventSources: readonly CapabilityEventSourceContribution[];
  actionProviders: readonly string[];
  hookScopes: readonly BackofficeHookScope[];
  skillPaths: readonly string[];
  externalEntities: readonly AutomationExternalEntityDefinition[];
  automationEvents: readonly BackofficeAutomationEventDescriptor[];
};

export type BackofficeCapability = {
  id: BackofficeCapabilityId;
  label: string;
  objectBinding: BackofficeObjectBindingName | null;
  contributions: CapabilityContributions;
};

export type BackofficeSystemCapability = BackofficeCapability & {
  contributions: CapabilityContributions & { connection: null };
};

export const backofficeCapabilities: readonly BackofficeCapability[] = [
  apiCapability,
  telegramCapability,
  mcpCapability,
  connectorCapability,
  resendCapability,
  reson8Capability,
  uploadCapability,
  piCapability,
  sandboxCapability,
  otpCapability,
  automationsCapability,
  githubCapability,
  integrationsCapability,
  authCapability,
  formsCapability,
  codemodeCapability,
];

export type BackofficeConnectionCatalogEntry = {
  id: BackofficeCapabilityId;
  label: string;
  kind: BackofficeCapabilityKind;
  configurable: boolean;
  description: string;
  routeSegment?: string;
};

export const backofficeConnectionCatalog: readonly BackofficeConnectionCatalogEntry[] = [
  {
    id: "telegram",
    label: "Telegram",
    kind: "connection",
    configurable: true,
    description: "Capture chat activity, configure webhooks, and send messages as a bot.",
    routeSegment: "telegram",
  },
  {
    id: "resend",
    label: "Resend",
    kind: "connection",
    configurable: true,
    description: "Send emails, register webhooks, and monitor delivery status.",
    routeSegment: "resend",
  },
  {
    id: "upload",
    label: "Upload",
    kind: "connection",
    configurable: true,
    description: "Configure org-scoped storage, inspect files, and run manual upload actions.",
    routeSegment: "upload",
  },
  {
    id: "reson8",
    label: "Reson8",
    kind: "connection",
    configurable: true,
    description: "Transcribe recorded audio, capture realtime speech, and manage custom models.",
    routeSegment: "reson8",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    kind: "connection",
    configurable: false,
    description: "Start isolated Cloudflare sandboxes and execute shell commands.",
  },
  {
    id: "github",
    label: "GitHub",
    kind: "connection",
    configurable: false,
    description: "Track installation webhooks, link repositories, and inspect pull requests.",
    routeSegment: "github",
  },
];

export function getBackofficeCapabilityKind(
  capability: BackofficeCapability,
): BackofficeCapabilityKind {
  return capability.contributions.connection ? "connection" : "system";
}

export function listCapabilityEventSources() {
  return backofficeCapabilities.flatMap((capability) =>
    capability.contributions.eventSources.map((eventSource) => ({
      ...eventSource,
      capabilityId: capability.id,
    })),
  );
}

export function listAutomationEventDescriptors() {
  return backofficeCapabilities.flatMap((capability) =>
    capability.contributions.automationEvents.map((event) => ({
      ...event,
      capabilityId: capability.id,
      payloadSchema: zodSchemaToJsonSchema(event.payloadSchema),
      actorSchema: zodSchemaToJsonSchema(event.actorSchema),
      subjectSchema: zodSchemaToJsonSchema(event.subjectSchema),
    })),
  );
}

export function listHookScopes() {
  return backofficeCapabilities.flatMap((capability) =>
    capability.contributions.hookScopes.map((hook) => ({
      id: hook.id,
      label: hook.label,
      capabilityId: capability.id,
      capabilityLabel: capability.label,
      kind: getBackofficeCapabilityKind(capability),
    })),
  );
}

export function getHookScope(id: string) {
  return backofficeCapabilities
    .flatMap((capability) => capability.contributions.hookScopes)
    .find((hook) => hook.id === id);
}

export const AUTOMATION_SOURCES = {
  auth: AUTH_AUTOMATION_SOURCE,
  forms: FORMS_AUTOMATION_SOURCE,
  telegram: "telegram",
  otp: "otp",
  pi: "pi",
} as const;

export const AUTOMATION_SOURCE_EVENT_TYPES = {
  [AUTOMATION_SOURCES.auth]: {
    organizationCreated: AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
    organizationUpdated: AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  },
  [AUTOMATION_SOURCES.forms]: {
    formCreated: FORMS_AUTOMATION_EVENT_FORM_CREATED,
    formUpdated: FORMS_AUTOMATION_EVENT_FORM_UPDATED,
    formDeleted: FORMS_AUTOMATION_EVENT_FORM_DELETED,
    responseSubmitted: FORMS_AUTOMATION_EVENT_RESPONSE_SUBMITTED,
  },
  [AUTOMATION_SOURCES.telegram]: {
    messageReceived: "message.received",
  },
  [AUTOMATION_SOURCES.otp]: {
    identityClaimCompleted: "identity.claim.completed",
  },
  [AUTOMATION_SOURCES.pi]: {
    capabilityConfigured: "capability.configured",
  },
} as const;

export type AutomationSource = (typeof AUTOMATION_SOURCES)[keyof typeof AUTOMATION_SOURCES];

export type AutomationEventTypeForSource<S extends AutomationSource> =
  (typeof AUTOMATION_SOURCE_EVENT_TYPES)[S][keyof (typeof AUTOMATION_SOURCE_EVENT_TYPES)[S]];
