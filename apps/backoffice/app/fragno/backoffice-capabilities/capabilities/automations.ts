import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const projectSchema = z.object({
  id: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdByUserId: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const projectPayloadSchema = z.object({
  project: projectSchema,
});

const projectSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

export const automationsCapability: BackofficeCapability = {
  id: "automations",
  label: "Automations",
  kind: "system",
  runtimeToolNamespaces: ["store", "router", "workflow", "hooks", "events"],
  hooks: [
    {
      id: "automations",
      label: "Automations",
      getRepository: ({ objects, orgId }) =>
        objects.automations.forOrg(orgId).getDurableHookRepository("automation"),
    },
  ],
  automationEvents: [
    {
      source: "automations",
      eventType: "project.created",
      label: "Project created",
      description: "Fires after an automation project is created in an organisation.",
      payloadSchema: projectPayloadSchema,
      subjectSchema: projectSubjectSchema,
      example: {
        project: {
          id: "project_123",
          slug: "launch-plan",
          name: "Launch Plan",
          description: null,
          archivedAt: null,
          createdByUserId: "user_123",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
    {
      source: "automations",
      eventType: "project.updated",
      label: "Project updated",
      description: "Fires after an automation project's editable fields change.",
      payloadSchema: projectPayloadSchema,
      subjectSchema: projectSubjectSchema,
      example: {
        project: {
          id: "project_123",
          slug: "launch-plan",
          name: "Launch Plan v2",
          description: "Updated launch workspace.",
          archivedAt: null,
          createdByUserId: "user_123",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    },
    {
      source: "automations",
      eventType: "project.archived",
      label: "Project archived",
      description: "Fires after an automation project is archived.",
      payloadSchema: projectPayloadSchema,
      subjectSchema: projectSubjectSchema,
      example: {
        project: {
          id: "project_123",
          slug: "launch-plan",
          name: "Launch Plan",
          description: null,
          archivedAt: "2026-01-03T00:00:00.000Z",
          createdByUserId: "user_123",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    },
  ],
};
