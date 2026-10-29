import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  formatUsageLimit,
  formatUsageQuantity,
  parseUsageLimitSetting,
  usageLimitedMeterSchema,
  type UsageLimits,
} from "@/fragno/billing/usage-limits";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool, type BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

type AdminUsageLimitsToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

/** An organization by slug, or a user's personal account by ID. */
export type AdminUsageLimitOwner =
  | { kind: "org"; organizationSlug: string }
  | { kind: "user"; userId: string };

const setUsageLimitInputSchema = z
  .strictObject({
    organizationSlug: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    meter: usageLimitedMeterSchema,
    limit: z.string().trim().min(1),
  })
  .transform(({ organizationSlug, userId, meter, limit }, context) => {
    if ((organizationSlug === undefined) === (userId === undefined)) {
      context.addIssue({ code: "custom", message: "Name exactly one of --org and --user." });
      return z.NEVER;
    }
    let setting;
    try {
      setting = parseUsageLimitSetting(meter, limit);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message, path: ["limit"] });
      return z.NEVER;
    }
    const owner: AdminUsageLimitOwner =
      organizationSlug === undefined
        ? { kind: "user", userId: userId! }
        : { kind: "org", organizationSlug };
    return { owner, meter, setting };
  });

const usageLimitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("limited"), quantity: z.string() }),
  z.strictObject({ kind: z.literal("unlimited") }),
]);

const usageLimitsSchema = z.strictObject({
  period: z.string(),
  limits: z.array(
    z.strictObject({
      meter: usageLimitedMeterSchema,
      unit: z.string(),
      setting: z.enum(["default", "custom"]),
      limit: usageLimitSchema,
      used: z.string(),
    }),
  ),
}) satisfies z.ZodType<UsageLimits>;

function formatUsageLimitsText({ period, limits }: UsageLimits): string {
  return [
    `Usage limits for ${period}:`,
    ...limits.map(
      (status) =>
        `  ${status.meter}: ${formatUsageQuantity(status.meter, status.used)} used of ${formatUsageLimit(status.meter, status.limit)} (${status.setting})`,
    ),
  ].join("\n");
}

const setUsageLimitTool = defineBackofficeRuntimeTool({
  id: "admin.usage-limits.set",
  namespace: "admin",
  name: "usageLimitsSet",
  description:
    "Set an organization's or a user's monthly limit on a metered resource: ai.cost.total, the cost of models and Workers AI in USD. Once the owner's usage this UTC month reaches it, new agent prompts and model calls are refused; work already running finishes. `default` restores the deployment's limit.",
  requiredPermissions: [
    BACKOFFICE_PERMISSION.admin.organizationsManage,
    BACKOFFICE_PERMISSION.admin.usersManage,
  ],
  inputSchema: setUsageLimitInputSchema,
  outputSchema: usageLimitsSchema,
  execute: async (input, context: AdminUsageLimitsToolContext) => {
    const admin = context.runtimes.admin;
    if (!admin) {
      throw new Error("Admin runtime is not available in this execution context.");
    }
    return await admin.setUsageLimit(input);
  },
  adapters: {
    bash: {
      command: "admin.usage-limits.set",
      help: {
        summary:
          "admin.usage-limits.set sets an organization's or a user's monthly limit on ai.cost.total (USD).",
        options: [
          {
            name: "org",
            valueRequired: true,
            valueName: "slug",
            description: "Slug of the organization, or use --user",
          },
          {
            name: "user",
            valueRequired: true,
            valueName: "id",
            description: "ID of the user whose personal account is limited, or use --org",
          },
          {
            name: "meter",
            required: true,
            valueRequired: true,
            valueName: "meter",
            description: "ai.cost.total",
          },
          {
            name: "limit",
            required: true,
            valueRequired: true,
            valueName: "amount",
            description: "An amount in USD, unlimited, or default",
          },
        ],
        examples: [
          "admin.usage-limits.set --org acme --meter ai.cost.total --limit 50",
          "admin.usage-limits.set --user user_123 --meter ai.cost.total --limit unlimited",
          "admin.usage-limits.set --org acme --meter ai.cost.total --limit default --format json",
        ],
      },
      parse: defineCliArgsParser("admin.usage-limits.set", {
        organizationSlug: { kind: "string", option: "org" },
        userId: { kind: "string", option: "user" },
        meter: { kind: "string", required: true },
        limit: { kind: "string", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${formatUsageLimitsText(result)}\n` },
    },
  },
});

export const adminUsageLimitsRuntimeTools = [setUsageLimitTool] as const;
