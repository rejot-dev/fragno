import { z } from "zod";

import type {
  AutomationsDurableHookFragment,
  AutomationsObject,
} from "@/backoffice-runtime/object-registry";
import { automationScheduleCadenceSchema } from "@/fragno/automation/route-triggers";
import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";
import type { DurableHookRepository } from "@/fragno/durable-hooks";

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

const scheduleTriggeredPayloadSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  cadence: automationScheduleCadenceSchema,
});

function createAutomationsDurableHookRepository(
  commands: AutomationsObject,
  fragment: AutomationsDurableHookFragment,
): DurableHookRepository {
  return createDurableHookRepositoryFromCommands({
    getDurableHookQueue: async (options) => await commands.getDurableHookQueue(fragment, options),
    getDurableHook: async (hookId) => await commands.getDurableHook(fragment, hookId),
  });
}

export const automationsCapability: BackofficeCapability = {
  id: "automations",
  label: "Automations",
  objectBinding: null,
  contributions: {
    connection: null,
    eventSources: [
      {
        source: "automations",
        label: "Projects",
        description: "Backoffice project lifecycle events.",
      },
      {
        source: "scheduler",
        label: "Scheduler",
        description: "One-time and recurring automation schedules.",
      },
    ],
    actionProviders: ["store", "router", "workflow", "hooks", "events"],
    hookScopes: [
      {
        id: "automations",
        label: "Automations",
        getRepository: ({ objects, orgId }) =>
          createAutomationsDurableHookRepository(
            objects.automations.forOrg(orgId).commands,
            "automation",
          ),
      },
      {
        id: "workflows",
        label: "Workflows",
        getRepository: ({ objects, scope }) =>
          createAutomationsDurableHookRepository(
            objects.automations.for(scope).commands,
            "workflows",
          ),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: "scheduler",
        eventType: "schedule.triggered",
        label: "Schedule triggered",
        description: "Fires when a scheduled automation route reaches its next occurrence.",
        payloadSchema: scheduleTriggeredPayloadSchema,
        example: {
          id: "daily-report",
          name: "Daily report",
          cadence: {
            kind: "cron",
            expression: "0 9 * * *",
            timeZone: "UTC",
          },
        },
      },
      {
        source: "automations",
        eventType: "project.created",
        label: "Project created",
        description: "Fires after an automation project is created in an organization.",
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
  },
};
