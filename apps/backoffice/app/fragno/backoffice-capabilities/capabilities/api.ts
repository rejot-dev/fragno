import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createApiCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/api-files";

import type { ApiAdminConfigResponse } from "../../../../workers/api.do";

export const apiConfigureInputSchema = z.object({});

const AUTOMATION_SOURCE = "api" as const;
const AUTOMATION_EVENT_CONNECTION_CHANGED = "connection.changed" as const;
const AUTOMATION_EVENT_CONNECTION_DELETED = "connection.deleted" as const;
const AUTOMATION_EVENT_CONNECTION_AVAILABLE = "connection.available" as const;

const apiConnectionSnapshotSchema = z.object({
  slug: z.string().min(1),
  name: z.string().nullable(),
  baseUrl: z.string().url(),
  authMode: z.string().min(1),
  status: z.string().min(1),
});

const apiConnectionChangedPayloadSchema = z.object({
  connectionId: z.string().min(1),
  connection: apiConnectionSnapshotSchema,
});

const apiConnectionDeletedPayloadSchema = z.object({
  connectionId: z.string().min(1),
  previous: apiConnectionSnapshotSchema,
});

const apiConnectionAvailablePayloadSchema = z.object({
  connectionId: z.string().min(1),
  connection: apiConnectionSnapshotSchema,
  authMode: z.string().min(1),
});

const apiConnectionSubjectSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
});

const capability = { id: "api", label: "API", kind: "connection" } as const;
const getApiDo = (objects: BackofficeObjectRegistry, orgId: string) => objects.api.forOrg(orgId);

const toApiStatus = (response: ApiAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["initialization"],
      nextSteps: ["Initialize API integrations for this organisation."],
    };
  }

  return {
    ...capability,
    configured: true,
    config: response.config,
  };
};

export const apiCapability: BackofficeConfigurableConnectionCapability = {
  ...capability,
  runtimeToolNamespaces: ["api"],
  get files() {
    return createApiCapabilityFiles();
  },
  connection: {
    configurable: true,
    configureInputSchema: apiConfigureInputSchema,
    configureFields: [],
    getStatus: async ({ objects, orgId }) =>
      toApiStatus(await getApiDo(objects, orgId).getAdminConfig()),
    verify: async ({ objects, orgId }) =>
      toApiStatus(await getApiDo(objects, orgId).getAdminConfig()),
    reset: async ({ objects, orgId }) =>
      toApiStatus(await getApiDo(objects, orgId).resetAdminConfig()),
    configure: async ({ objects, orgId, payload }) =>
      toApiStatus(
        await getApiDo(objects, orgId).setAdminConfig({
          ...apiConfigureInputSchema.parse(payload),
          orgId,
        }),
      ),
  },
  hooks: [
    {
      id: "api",
      label: "API",
      getRepository: ({ objects, orgId }) => getApiDo(objects, orgId).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CONNECTION_CHANGED,
      label: "API connection changed",
      description: "Fires when an API connection is created or its configuration changes.",
      payloadSchema: apiConnectionChangedPayloadSchema,
      subjectSchema: apiConnectionSubjectSchema,
      example: {
        connectionId: "stripe-api",
        connection: {
          slug: "stripe-api",
          name: "Stripe API",
          baseUrl: "https://api.stripe.com",
          authMode: "bearer",
          status: "active",
        },
      },
    },
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CONNECTION_DELETED,
      label: "API connection deleted",
      description: "Fires when an API connection is deleted.",
      payloadSchema: apiConnectionDeletedPayloadSchema,
      subjectSchema: apiConnectionSubjectSchema,
      example: {
        connectionId: "stripe-api",
        previous: {
          slug: "stripe-api",
          name: "Stripe API",
          baseUrl: "https://api.stripe.com",
          authMode: "bearer",
          status: "active",
        },
      },
    },
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CONNECTION_AVAILABLE,
      label: "API connection available",
      description: "Fires when configured API authentication becomes usable.",
      payloadSchema: apiConnectionAvailablePayloadSchema,
      subjectSchema: apiConnectionSubjectSchema,
      example: {
        connectionId: "stripe-api",
        authMode: "bearer",
        connection: {
          slug: "stripe-api",
          name: "Stripe API",
          baseUrl: "https://api.stripe.com",
          authMode: "bearer",
          status: "active",
        },
      },
    },
  ],
};
