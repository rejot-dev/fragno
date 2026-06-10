import type { z } from "zod";

import type { AutomationExternalEntityDefinition } from "@/fragno/automation/contracts";
import type { DurableHookQueueOptions, DurableHookRepository } from "@/fragno/durable-hooks";
import { zodSchemaToJsonSchema } from "@/lib/zod/zod-formatter";

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

type BackofficeCapabilitySkillFilesInput = {
  /**
   * Agent Skills spec name. Must match the generated skill directory name and use lowercase
   * letters, numbers, and hyphens only.
   */
  name: string;
  /**
   * Frontmatter description used by agents to decide when to load the skill. Keep it
   * trigger-oriented and keyword-rich.
   */
  description: string;
  /** Human-readable Markdown H1 shown at the top of SKILL.md. */
  title: string;
  /** Short body introduction shown after the skill is already selected. */
  overview: string;
  /** Capability setup and configuration guidance. */
  configuration: string;
  /** Automation events, hook behavior, event schemas, and inspection guidance. */
  events: string;
  /** Runtime tools, commands, providers, and usage examples for this capability. */
  tools: string;
};

export const skillFiles = ({
  name,
  description,
  title,
  overview,
  configuration,
  events,
  tools,
}: BackofficeCapabilitySkillFilesInput): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: ${description}
---

# ${title}

${overview}

${configuration}

${events}

${tools}
`,
});

type BackofficeConnectionDescriptorBase = {
  getStatus(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
  verify?(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
};

export type BackofficeConfigurableConnectionDescriptor = BackofficeConnectionDescriptorBase & {
  configurable: true;
  configureInputSchema?: z.ZodType;
  configureFields?: readonly BackofficeConnectionConfigureField[];
  reset?(input: { env: CloudflareEnv; orgId: string }): Promise<ConnectionStatus>;
  configure(input: {
    env: CloudflareEnv;
    orgId: string;
    origin: string;
    payload: unknown;
  }): Promise<ConnectionStatus>;
};

export type BackofficeManagedConnectionDescriptor = BackofficeConnectionDescriptorBase & {
  configurable: false;
  configureInputSchema?: never;
  configureFields?: never;
  reset?: never;
  configure?: never;
};

export type BackofficeConnectionDescriptor =
  | BackofficeConfigurableConnectionDescriptor
  | BackofficeManagedConnectionDescriptor;

type BackofficeCapabilityBase = {
  id: BackofficeCapabilityId;
  label: string;
  runtimeToolNamespaces?: readonly string[];
  files?: Readonly<Record<string, string>>;
  hooks?: readonly BackofficeHookScope[];
  externalEntities?: readonly AutomationExternalEntityDefinition[];
  automationEvents?: readonly BackofficeAutomationEventDescriptor[];
};

export type BackofficeConfigurableConnectionCapability = BackofficeCapabilityBase & {
  kind: "connection";
  connection: BackofficeConfigurableConnectionDescriptor;
};

export type BackofficeManagedConnectionCapability = BackofficeCapabilityBase & {
  kind: "connection";
  connection: BackofficeManagedConnectionDescriptor;
};

export type BackofficeConnectionCapability =
  | BackofficeConfigurableConnectionCapability
  | BackofficeManagedConnectionCapability;

export type BackofficeSystemCapability = BackofficeCapabilityBase & {
  kind: "system";
  connection?: never;
};

export type BackofficeCapability = BackofficeConnectionCapability | BackofficeSystemCapability;

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

export const listAutomationEventDescriptors = () =>
  backofficeCapabilities.flatMap((capability) =>
    (capability.automationEvents ?? []).map((event) => ({
      ...event,
      capabilityId: capability.id,
      payloadSchema: zodSchemaToJsonSchema(event.payloadSchema),
      actorSchema: zodSchemaToJsonSchema(event.actorSchema),
      subjectSchema: zodSchemaToJsonSchema(event.subjectSchema),
    })),
  );

const isConnectionCapability = (
  capability: BackofficeCapability,
): capability is BackofficeConnectionCapability => capability.kind === "connection";

export const listConnectionCapabilities = () =>
  backofficeCapabilities.filter(isConnectionCapability);

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
  pi: "pi",
} as const;

export const AUTOMATION_SOURCE_EVENT_TYPES = {
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
