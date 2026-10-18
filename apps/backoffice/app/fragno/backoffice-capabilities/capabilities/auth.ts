import {
  backofficeProvisioningOperations,
  type BackofficeProvisioningOperationId,
} from "@fragno-dev/backoffice-api/v0/provisioning";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

export const AUTH_AUTOMATION_SOURCE = "auth" as const;
export const AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED = "organization.created" as const;
export const AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED = "organization.updated" as const;

/** First-party apps' provisioning, recorded in the System scope as its audit trail. */
export const PROVISIONING_AUTOMATION_SOURCE = "provisioning" as const;
export const PROVISIONING_AUTOMATION_EVENTS = {
  "users.provision": { eventType: "user.provisioned", label: "User provisioned" },
  "organizations.provision": {
    eventType: "organization.provisioned",
    label: "Organization provisioned",
  },
  "projects.provision": { eventType: "project.provisioned", label: "Project provisioned" },
  "organizations.members.sync": {
    eventType: "organization.members.synced",
    label: "Organization members synced",
  },
} as const satisfies Record<
  BackofficeProvisioningOperationId,
  { eventType: string; label: string }
>;

const provisioningActorSchema = z.object({
  scope: z.literal("internal"),
  type: z.literal("app"),
  id: z.string().trim().min(1),
  role: z.literal("initiator"),
});

const authOrganizationPayloadSchema = z.object({
  organization: z.object({
    id: z.string().trim().min(1),
    name: z.string(),
    slug: z.string(),
    logoUrl: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdBy: z.string().trim().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  }),
});

const authOrganizationActorSchema = z.union([
  z.object({
    scope: z.literal("internal"),
    type: z.literal("user"),
    id: z.string().trim().min(1),
    role: z.literal("initiator"),
  }),
  z.object({
    scope: z.literal("internal"),
    type: z.literal("system"),
    id: z.string().trim().min(1),
    role: z.literal("initiator"),
  }),
]);

const authOrganizationSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
});

export const authCapability: BackofficeCapability = {
  id: "auth",
  label: "Auth",
  objectBinding: null,
  contributions: {
    connection: null,
    eventSources: [
      {
        source: AUTH_AUTOMATION_SOURCE,
        label: "Organizations",
        description: "Backoffice organization lifecycle events.",
      },
      {
        source: PROVISIONING_AUTOMATION_SOURCE,
        label: "Provisioning",
        description:
          "First-party apps provisioning users, organizations, projects, and memberships.",
      },
    ],
    actionProviders: [],
    hookScopes: [
      {
        id: "auth",
        label: "Auth",
        getRepository: ({ objects }) =>
          createDurableHookRepositoryFromCommands(objects.auth.singleton().commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      ...Object.entries(PROVISIONING_AUTOMATION_EVENTS).map(([operationId, event]) => {
        const operation =
          backofficeProvisioningOperations[operationId as BackofficeProvisioningOperationId];
        return {
          source: PROVISIONING_AUTOMATION_SOURCE,
          eventType: event.eventType,
          label: event.label,
          description: `Records a first-party app's ${operationId} call: ${operation.description}`,
          payloadSchema: z.object({
            appId: z.string().trim().min(1),
            input: operation.input,
            result: operation.output,
          }),
          actorSchema: provisioningActorSchema,
        };
      }),
      {
        source: AUTH_AUTOMATION_SOURCE,
        eventType: AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
        label: "Organization created",
        description: "Fires after a Backoffice organization is created.",
        payloadSchema: authOrganizationPayloadSchema,
        actorSchema: authOrganizationActorSchema,
        subjectSchema: authOrganizationSubjectSchema,
        example: {
          organization: {
            id: "org_123",
            name: "Acme",
            slug: "acme",
            logoUrl: null,
            metadata: null,
            createdBy: "user_123",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        },
      },
      {
        source: AUTH_AUTOMATION_SOURCE,
        eventType: AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
        label: "Organization updated",
        description: "Fires after a Backoffice organization is updated.",
        payloadSchema: authOrganizationPayloadSchema,
        actorSchema: authOrganizationActorSchema,
        subjectSchema: authOrganizationSubjectSchema,
        example: {
          organization: {
            id: "org_123",
            name: "Acme Inc.",
            slug: "acme",
            logoUrl: null,
            metadata: { plan: "pro" },
            createdBy: "user_123",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            deletedAt: null,
          },
        },
      },
    ],
  },
};
