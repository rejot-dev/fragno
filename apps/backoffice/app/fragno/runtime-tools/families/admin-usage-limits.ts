import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  formatUsageLimit,
  formatUsageQuantity,
  parseUsageLimitSetting,
  usageLimitedMeterSchema,
  type UsageLimits,
} from "@/fragno/billing/usage-limits";
import type { AutomationCommandOutputOptions } from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool, type BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

type AdminUsageLimitsToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

/** An organization by slug, or a user's personal account by ID. */
export type AdminUsageLimitOwner =
  | { kind: "org"; organizationSlug: string }
  | { kind: "user"; userId: string };

const usageLimitOwnerInputSchema = z
  .strictObject({
    organizationSlug: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
  })
  .refine(
    ({ organizationSlug, userId }) => (organizationSlug === undefined) !== (userId === undefined),
    { message: "Name exactly one of --org and --user." },
  );

function selectUsageLimitOwner({
  organizationSlug,
  userId,
}: z.output<typeof usageLimitOwnerInputSchema>): AdminUsageLimitOwner {
  return organizationSlug === undefined
    ? { kind: "user", userId: userId! }
    : { kind: "org", organizationSlug };
}

const setUsageLimitInputSchema = usageLimitOwnerInputSchema
  .safeExtend({
    meter: usageLimitedMeterSchema,
    limit: z.string().trim().min(1),
  })
  .transform(({ meter, limit, ...owner }, context) => {
    try {
      const setting = parseUsageLimitSetting(meter, limit);
      return { owner: selectUsageLimitOwner(owner), meter, setting };
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message, path: ["limit"] });
      return z.NEVER;
    }
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

function formatUsageLimits(result: UsageLimits, options: AutomationCommandOutputOptions) {
  return options.format === "json" || options.print
    ? { data: result }
    : { data: result, stdout: `${formatUsageLimitsText(result)}\n` };
}

const usageLimitPermissions = [
  BACKOFFICE_PERMISSION.admin.organizationsManage,
  BACKOFFICE_PERMISSION.admin.usersManage,
] as const;

const usageLimitOwnerOptions = [
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
];

const usageLimitOwnerArgs = {
  organizationSlug: { kind: "string", option: "org" },
  userId: { kind: "string", option: "user" },
} as const;

const getUsageLimitsTool = defineBackofficeRuntimeTool({
  id: "admin.usage-limits.get",
  namespace: "admin",
  name: "usageLimitsGet",
  activity: {
    label: "Read usage limits",
    target: (owner) => (owner.kind === "org" ? owner.organizationSlug : owner.userId),
  },
  description:
    "Read an organization's or a user's effective usage limits, current usage, and default or custom settings for the current UTC month.",
  requiredPermissions: usageLimitPermissions,
  inputSchema: usageLimitOwnerInputSchema.transform(selectUsageLimitOwner),
  outputSchema: usageLimitsSchema,
  execute: async (owner, context: AdminUsageLimitsToolContext) => {
    const admin = context.runtimes.admin;
    if (!admin) {
      throw new Error("Admin runtime is not available in this execution context.");
    }
    return await admin.getUsageLimits({ owner });
  },
  adapters: {
    bash: {
      command: "admin.usage-limits.get",
      help: {
        summary:
          "admin.usage-limits.get reads an organization's or a user's limits and usage for the current UTC month.",
        options: usageLimitOwnerOptions,
        examples: [
          "admin.usage-limits.get --org acme",
          "admin.usage-limits.get --user user_123 --format json",
        ],
      },
      parse: defineCliArgsParser("admin.usage-limits.get", usageLimitOwnerArgs),
      format: formatUsageLimits,
    },
  },
});

const setUsageLimitTool = defineBackofficeRuntimeTool({
  id: "admin.usage-limits.set",
  namespace: "admin",
  name: "usageLimitsSet",
  activity: {
    label: "Set usage limit",
    target: ({ meter, owner }) =>
      `${meter} for ${owner.kind === "org" ? owner.organizationSlug : owner.userId}`,
  },
  description:
    "Set an organization's or a user's monthly limit on a metered resource: ai.cost.total, the cost of models and Workers AI in USD, or email.sent, the emails a person sends from their own address. Once the owner's usage this UTC month reaches it, new agent prompts and model calls, or new emails, are refused; work already running finishes. `default` restores the deployment's limit.",
  requiredPermissions: usageLimitPermissions,
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
          "admin.usage-limits.set sets an organization's or a user's monthly limit on ai.cost.total (USD) or email.sent (emails).",
        options: [
          ...usageLimitOwnerOptions,
          {
            name: "meter",
            required: true,
            valueRequired: true,
            valueName: "meter",
            description: "ai.cost.total or email.sent",
          },
          {
            name: "limit",
            required: true,
            valueRequired: true,
            valueName: "amount",
            description: "An amount in the meter's unit (USD or emails), unlimited, or default",
          },
        ],
        examples: [
          "admin.usage-limits.set --org acme --meter ai.cost.total --limit 50",
          "admin.usage-limits.set --user user_123 --meter ai.cost.total --limit unlimited",
          "admin.usage-limits.set --user user_123 --meter email.sent --limit 500",
          "admin.usage-limits.set --org acme --meter ai.cost.total --limit default --format json",
        ],
      },
      parse: defineCliArgsParser("admin.usage-limits.set", {
        ...usageLimitOwnerArgs,
        meter: { kind: "string", required: true },
        limit: { kind: "string", required: true },
      }),
      format: formatUsageLimits,
    },
  },
});

export const adminUsageLimitsRuntimeTools = [getUsageLimitsTool, setUsageLimitTool] as const;
