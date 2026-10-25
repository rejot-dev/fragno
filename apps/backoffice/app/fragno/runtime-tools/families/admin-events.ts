import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { PI_AUTOMATION_SOURCE } from "@/fragno/backoffice-capabilities/capabilities/pi";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { AdminRuntime } from "./admin";
import { INTEGRATIONS_EVENT_SOURCE } from "./integrations/integration-events";

type AdminEventsToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

/**
 * Sources whose whole history the dashboard folds into current agents and connections. The
 * Automations replica's projections (`automation/lofi/views.ts`) fold each event as it arrives, so
 * they stay correct only while these events are never deleted.
 */
const FOLDED_EVENT_SOURCES: ReadonlySet<string> = new Set([
  PI_AUTOMATION_SOURCE,
  INTEGRATIONS_EVENT_SOURCE,
]);

/**
 * Completed ingestion hooks are kept for seven days, and a redelivered event recreated under a
 * kept hook's ID fails. Idle organizations keep them longer, but their webhooks are not redelivered
 * that late: delivering fragments deduplicate for seven days after processing.
 */
const MIN_STORAGE_AGE_MS = 8 * 24 * 60 * 60 * 1000;

const DANGER_REQUIRED = "Deleting events is permanent; pass --danger to confirm.";

const deleteEventsInputSchema = z.strictObject({
  organizationSlug: z.string().trim().min(1),
  source: z
    .string()
    .trim()
    .min(1)
    .refine(
      (source) => !FOLDED_EVENT_SOURCES.has(source),
      `Events from ${[...FOLDED_EVENT_SOURCES].join(" or ")} hold current agent or connection state and cannot be deleted.`,
    ),
  eventType: z.string().trim().min(1),
  occurredBefore: z
    .union([z.iso.datetime({ offset: true }), z.iso.date()])
    .transform((value) => new Date(value)),
  payloadFilter: z
    .strictObject({
      field: z.string().trim().min(1),
      values: z.array(z.string().min(1)).min(1),
    })
    .nullable()
    .default(null),
  cursor: z.string().min(1).nullable().default(null),
  dryRun: z.boolean().default(false),
  danger: z.literal(true, { error: DANGER_REQUIRED }),
});

const deleteEventsOutputSchema = z.strictObject({
  dryRun: z.boolean(),
  scanned: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
});

const parseDeleteEventsArgs = defineCliArgsParser<{
  organizationSlug: string;
  source: string;
  eventType: string;
  before: string;
  payloadField?: string;
  payloadValue?: string[];
  cursor?: string;
  dryRun?: boolean;
  danger?: boolean;
}>("admin.events.delete", {
  organizationSlug: { kind: "string", required: true, option: "org" },
  source: { kind: "string", required: true },
  eventType: { kind: "string", required: true },
  before: { kind: "string", required: true },
  payloadField: { kind: "string" },
  payloadValue: { kind: "stringArray" },
  cursor: { kind: "string" },
  dryRun: { kind: "boolean" },
  danger: { kind: "boolean" },
});

const deleteEventsTool = defineBackofficeRuntimeTool({
  id: "admin.events.delete",
  namespace: "admin",
  name: "eventsDelete",
  description:
    "Permanently delete one pass of an organization's stored events of one type, oldest first, with their sync history. Repeat with the returned cursor until it is null.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: deleteEventsInputSchema,
  outputSchema: deleteEventsOutputSchema,
  execute: async ({ danger: _danger, ...input }, context: AdminEventsToolContext) => {
    const admin = context.runtimes.admin;
    if (!admin) {
      throw new Error("Admin runtime is not available in this execution context.");
    }
    const result = await admin.deleteOrganizationEventsOfType({
      ...input,
      storedBefore: new Date(Date.now() - MIN_STORAGE_AGE_MS),
    });
    return { dryRun: input.dryRun, ...result };
  },
  adapters: {
    bash: {
      command: "admin.events.delete",
      help: {
        summary:
          "admin.events.delete permanently deletes up to 50 of an organization's oldest stored events of one type, and their sync history, so browsers stop downloading them. Events stored in the last 8 days or whose routes are still being matched are kept, as are route dispatch records; traces rooted at a deleted event lose their root. pi and integrations events cannot be deleted.",
        options: [
          {
            name: "org",
            required: true,
            valueRequired: true,
            valueName: "slug",
            description: "Organization slug",
          },
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Event source, such as github",
          },
          {
            name: "event-type",
            required: true,
            valueRequired: true,
            valueName: "type",
            description: "Event type, such as webhook.received",
          },
          {
            name: "before",
            required: true,
            valueRequired: true,
            valueName: "date",
            description:
              "Delete events that occurred before this ISO date; events stored in the last 8 days are kept",
          },
          {
            name: "payload-field",
            valueRequired: true,
            valueName: "field",
            description: "Only delete events whose top-level payload field holds a --payload-value",
          },
          {
            name: "payload-value",
            valueRequired: true,
            valueName: "value",
            description: "A string value of --payload-field to delete; repeatable",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous pass",
          },
          { name: "dry-run", description: "Count what the pass would delete without deleting" },
          { name: "danger", required: true, description: "Confirm the deletion is permanent" },
        ],
        examples: [
          "admin.events.delete --org acme --source github --event-type webhook.received --before 2026-10-01 --danger --dry-run",
          "admin.events.delete --org acme --source github --event-type webhook.received --before 2026-10-01 --payload-field githubEvent --payload-value workflow_run --payload-value workflow_job --danger",
        ],
      },
      parse: (args) => {
        const { before, payloadField, payloadValue, danger, ...parsed } =
          parseDeleteEventsArgs(args);
        if (danger !== true) {
          throw new Error(DANGER_REQUIRED);
        }
        if ((payloadField === undefined) !== (payloadValue === undefined)) {
          throw new Error("--payload-field and --payload-value must be passed together.");
        }
        return {
          ...parsed,
          occurredBefore: before,
          payloadFilter:
            payloadField === undefined || payloadValue === undefined
              ? null
              : { field: payloadField, values: payloadValue },
          danger,
        };
      },
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `Scanned ${result.scanned}, ${result.dryRun ? "would delete" : "deleted"} ${result.deleted}.\n${
                result.cursor === null ? "Done.\n" : `Next pass: --cursor ${result.cursor}\n`
              }`,
            },
    },
  },
});

/**
 * Only a signed-in administrator's own request can delete events. Agents and automations run
 * deferred, so the family is unavailable to them, and hidden keeps it out of Codemode's types.
 */
export const adminEventsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  tools: [deleteEventsTool],
  hidden: true,
  isAvailable: (context: AdminEventsToolContext) =>
    !!context.runtimes.admin && context.execution.kind === "request",
});
