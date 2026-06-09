import type { z } from "zod";

import type { DurableHookQueueOptions, DurableHookRepository } from "@/fragno/durable-hooks";

import { authCapability } from "./capabilities/auth";
import { automationsCapability } from "./capabilities/automations";
import { cloudflareCapability } from "./capabilities/cloudflare";
import { githubCapability } from "./capabilities/github";
import { otpCapability } from "./capabilities/otp";
import { piCapability } from "./capabilities/pi";
import { resendCapability } from "./capabilities/resend";
import { reson8Capability } from "./capabilities/reson8";
import { telegramCapability } from "./capabilities/telegram";
import { uploadCapability } from "./capabilities/upload";

export type BackofficeCapabilityKind = "connection" | "system";

export type BackofficeCapabilityId =
  | "automations"
  | "auth"
  | "cloudflare"
  | "github"
  | "otp"
  | "pi"
  | "resend"
  | "reson8"
  | "telegram"
  | "upload";

export type ConnectionStatus = {
  id: BackofficeCapabilityId;
  label: string;
  kind: BackofficeCapabilityKind;
  configured: boolean;
  config?: Record<string, unknown>;
  missing?: string[];
  nextSteps?: string[];
  verification?: { ok: boolean; message: string };
};

export type BackofficeHookScope = {
  id: string;
  label: string;
  getRepository(input: {
    env: CloudflareEnv;
    orgId: string;
  }):
    | Promise<DurableHookRepository<DurableHookQueueOptions>>
    | DurableHookRepository<DurableHookQueueOptions>;
};

export type BackofficeAutomationEventDescriptor = {
  source: string;
  eventType: string;
  label: string;
  description?: string;
  payloadSchema?: z.ZodType;
  actorSchema?: z.ZodType;
  subjectSchema?: z.ZodType;
  example?: unknown;
};

export type BackofficeConnectionConfigureField = {
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
};

export type BackofficeConnectionSetupGuide = {
  overview: string;
  manualSteps: readonly {
    id: string;
    title: string;
    instructions: string;
    expectedUserInput?: readonly string[];
  }[];
  verify?: {
    tool: string;
    description: string;
  };
};

export type BackofficeConnectionDescriptor = {
  configurable: boolean;
  configureInputSchema?: z.ZodType;
  configureFields?: readonly BackofficeConnectionConfigureField[];
  setup?: BackofficeConnectionSetupGuide;
  getStatus(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
  verify?(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
  reset?(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
  configure?(input: {
    env: CloudflareEnv;
    orgId: string;
    origin: string;
    payload: unknown;
  }): Promise<ConnectionStatus>;
};

export type BackofficeCapability = {
  id: BackofficeCapabilityId;
  label: string;
  kind: BackofficeCapabilityKind;
  runtimeToolNamespaces?: readonly string[];
  connection?: BackofficeConnectionDescriptor;
  hooks?: readonly BackofficeHookScope[];
  automationEvents?: readonly BackofficeAutomationEventDescriptor[];
};

export const backofficeCapabilities: readonly BackofficeCapability[] = [
  telegramCapability,
  resendCapability,
  reson8Capability,
  uploadCapability,
  piCapability,
  otpCapability,
  automationsCapability,
  githubCapability,
  cloudflareCapability,
  authCapability,
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
    id: "pi",
    label: "Pi",
    kind: "connection",
    configurable: true,
    description: "Configure model providers and Pi runtime harnesses.",
  },
  {
    id: "github",
    label: "GitHub",
    kind: "connection",
    configurable: false,
    description: "Track installation webhooks, link repositories, and inspect pull requests.",
    routeSegment: "github",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers",
    kind: "connection",
    configurable: false,
    description: "Track Worker activity and route Cloudflare hook events.",
  },
];

export const summarizeZodSchema = (schema: z.ZodType | undefined) => {
  if (!schema) {
    return undefined;
  }

  const getSchemaTypeName = (candidate: z.ZodType) => {
    const def = (candidate as unknown as { _def?: { type?: string; typeName?: string } })._def;
    return def?.type ?? def?.typeName ?? "unknown";
  };

  const getObjectKeys = (candidate: z.ZodType) => {
    const shape = (candidate as unknown as { shape?: unknown }).shape;
    if (!shape || typeof shape !== "object") {
      return undefined;
    }
    return Object.keys(shape as Record<string, unknown>);
  };

  return {
    type: getSchemaTypeName(schema),
    keys: getObjectKeys(schema) ?? [],
  };
};

export const listAutomationEventDescriptors = () =>
  backofficeCapabilities.flatMap((capability) =>
    (capability.automationEvents ?? []).map((event) => ({
      ...event,
      capabilityId: capability.id,
      payloadSchema: summarizeZodSchema(event.payloadSchema),
      actorSchema: summarizeZodSchema(event.actorSchema),
      subjectSchema: summarizeZodSchema(event.subjectSchema),
    })),
  );

export const listConnectionCapabilities = () =>
  backofficeCapabilities.filter(
    (capability) => capability.kind === "connection" && capability.connection,
  );

export const getConnectionCapability = (id: string) =>
  listConnectionCapabilities().find((capability) => capability.id === id);

export const listHookScopes = () =>
  backofficeCapabilities.flatMap((capability) =>
    (capability.hooks ?? []).map((hook) => ({
      id: hook.id,
      label: hook.label,
      capabilityId: capability.id,
      capabilityLabel: capability.label,
      kind: capability.kind,
    })),
  );

export const getHookScope = (id: string) =>
  backofficeCapabilities
    .flatMap((capability) => capability.hooks ?? [])
    .find((hook) => hook.id === id);

export const AUTOMATION_SOURCES = {
  telegram: "telegram",
  otp: "otp",
} as const;

export const AUTOMATION_SOURCE_EVENT_TYPES = {
  [AUTOMATION_SOURCES.telegram]: {
    messageReceived: "message.received",
  },
  [AUTOMATION_SOURCES.otp]: {
    identityClaimCompleted: "identity.claim.completed",
  },
} as const;

export type AutomationSource = (typeof AUTOMATION_SOURCES)[keyof typeof AUTOMATION_SOURCES];

export type AutomationEventTypeForSource<S extends AutomationSource> =
  (typeof AUTOMATION_SOURCE_EVENT_TYPES)[S][keyof (typeof AUTOMATION_SOURCE_EVENT_TYPES)[S]];

export type AutomationKnownEventType = {
  [S in AutomationSource]: AutomationEventTypeForSource<S>;
}[AutomationSource];

export type KnownAutomationEventDefinition = {
  source: AutomationSource;
  eventType: AutomationKnownEventType;
  payloadSchema: z.ZodType;
  actorSchema?: z.ZodType;
  subjectSchema?: z.ZodType;
  example?: unknown;
};
