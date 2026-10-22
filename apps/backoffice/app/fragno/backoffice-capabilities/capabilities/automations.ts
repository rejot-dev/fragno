import { automationScheduleCadenceSchema } from "@fragno-dev/backoffice-api/v0/automation";
import { z } from "zod";

import type {
  AutomationsDurableHookFragment,
  AutomationsObject,
} from "@/backoffice-runtime/object-registry";
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

const routeFailedPayloadSchema = z.object({
  route: z.object({ id: z.string(), name: z.string() }),
  event: z.object({ id: z.string(), source: z.string(), eventType: z.string() }),
  error: z.string(),
  failedAttempts: z.number().int().positive(),
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
        label: "Automations",
        description: "Backoffice project lifecycle events and routes that failed for good.",
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
        source: "automations",
        eventType: "route.failed",
        label: "Route failed",
        description:
          "Fires when a route fails for good on an event: its error cannot be fixed by retrying, or it ran out of attempts. Fires again each time a retried route fails. A route that fails on a route.failed event fires none.",
        payloadSchema: routeFailedPayloadSchema,
        example: {
          route: { id: "deliver-to-run", name: "Deliver to the triage run" },
          event: { id: "event-1", source: "github", eventType: "issues.opened" },
          error:
            "Workflow run triage-1 has finished, so it can no longer receive events (INSTANCE_TERMINAL).",
          failedAttempts: 1,
        },
      },
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
