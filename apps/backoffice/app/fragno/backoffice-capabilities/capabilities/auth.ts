import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const AUTH_AUTOMATION_SOURCE = "auth" as const;
export const AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED = "organization.created" as const;
export const AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED = "organization.updated" as const;

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

const authOrganizationActorSchema = z.object({
  scope: z.literal("internal"),
  type: z.literal("user"),
  id: z.string().trim().min(1),
  email: z.string().email(),
  role: z.enum(["user", "admin"]),
});

const authOrganizationSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
});

export const authCapability: BackofficeCapability = {
  id: "auth",
  label: "Auth",
  kind: "system",
  runtimeToolNamespaces: [],
  hooks: [
    {
      id: "auth",
      label: "Auth",
      getRepository: ({ objects }) => objects.auth.get().getDurableHookRepository(),
    },
  ],
  automationEvents: [
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
};
