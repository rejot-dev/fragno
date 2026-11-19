import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  featureFlagKeySchema,
  featureFlagStatusSchema,
  type FeatureFlagStatus,
} from "@/fragno/feature-flags/contracts";

import { defineCliArgsParser } from "../bash-cli";
import { defineBackofficeRuntimeTool } from "../runtime-tools";
import { requireSystemAdminRuntime, type AdminSystemToolContext } from "./admin-system-runtime";

const organizationFields = { organizationSlug: z.string().trim().min(1) };
const flagFields = { ...organizationFields, key: featureFlagKeySchema };
const organizationOption = {
  name: "org",
  required: true,
  valueRequired: true,
  valueName: "slug",
  description: "Organization slug",
};
const keyOption = {
  name: "key",
  required: true,
  valueRequired: true,
  valueName: "flag",
  description: "Feature flag key",
};
const organizationArg = { kind: "string", option: "org", required: true } as const;
const keyArg = { kind: "string", required: true } as const;

function describeFlag({ key, enabled, override, defaultEnabled, description }: FeatureFlagStatus) {
  return `${key}: ${enabled ? "on" : "off"} (${override === null ? "default" : "override"}, default ${defaultEnabled ? "on" : "off"}) — ${description}`;
}

const getFeatureFlagTool = defineBackofficeRuntimeTool({
  id: "admin.feature-flags.get",
  namespace: "admin",
  name: "featureFlagsGet",
  activity: {
    label: "Get feature flag",
    target: ({ organizationSlug, key }) => `${key} for ${organizationSlug}`,
  },
  description: "Get one feature flag's effective value, default, and override for an organization.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject(flagFields),
  outputSchema: featureFlagStatusSchema,
  execute: (input, context: AdminSystemToolContext) =>
    requireSystemAdminRuntime(context, "feature flags").getFeatureFlag(input),
  adapters: {
    bash: {
      command: "admin.feature-flags.get",
      help: {
        summary: "Get an organization's feature flag.",
        options: [organizationOption, keyOption],
        examples: ["admin.feature-flags.get --org acme --key organization-access-summary"],
      },
      parse: defineCliArgsParser("admin.feature-flags.get", {
        organizationSlug: organizationArg,
        key: keyArg,
      }),
      format: (data, options) =>
        options.format === "json" || options.print
          ? { data }
          : { data, stdout: `${describeFlag(data)}\n` },
    },
  },
});

const setFeatureFlagTool = defineBackofficeRuntimeTool({
  id: "admin.feature-flags.set",
  namespace: "admin",
  name: "featureFlagsSet",
  activity: {
    label: "Set feature flag",
    target: ({ organizationSlug, key }) => `${key} for ${organizationSlug}`,
  },
  description: "Set a feature flag on or off for an organization, or restore its default.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject({ ...flagFields, value: z.enum(["on", "off", "default"]) }),
  outputSchema: featureFlagStatusSchema,
  execute: ({ value, ...input }, context: AdminSystemToolContext) =>
    requireSystemAdminRuntime(context, "feature flags").setFeatureFlag({
      ...input,
      override: value === "default" ? null : value === "on",
    }),
  adapters: {
    bash: {
      command: "admin.feature-flags.set",
      help: {
        summary: "Set or clear an organization's feature flag override.",
        options: [
          organizationOption,
          keyOption,
          {
            name: "value",
            required: true,
            valueRequired: true,
            valueName: "setting",
            description: "on, off, or default",
          },
        ],
        examples: [
          "admin.feature-flags.set --org acme --key organization-access-summary --value off",
        ],
      },
      parse: defineCliArgsParser("admin.feature-flags.set", {
        organizationSlug: organizationArg,
        key: keyArg,
        value: { kind: "string", required: true },
      }),
      format: (data, options) =>
        options.format === "json" || options.print
          ? { data }
          : { data, stdout: `${describeFlag(data)}\n` },
    },
  },
});

const listFeatureFlagsTool = defineBackofficeRuntimeTool({
  id: "admin.feature-flags.list",
  namespace: "admin",
  name: "featureFlagsList",
  activity: { label: "List feature flags", target: ({ organizationSlug }) => organizationSlug },
  description: "List the available feature flags and their effective values for an organization.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject(organizationFields),
  outputSchema: z.array(featureFlagStatusSchema),
  execute: (input, context: AdminSystemToolContext) =>
    requireSystemAdminRuntime(context, "feature flags").listFeatureFlags(input),
  adapters: {
    bash: {
      command: "admin.feature-flags.list",
      help: {
        summary: "List an organization's feature flags.",
        options: [organizationOption],
        examples: ["admin.feature-flags.list --org acme"],
      },
      parse: defineCliArgsParser("admin.feature-flags.list", { organizationSlug: organizationArg }),
      format: (data, options) =>
        options.format === "json" || options.print
          ? { data }
          : { data, stdout: `${data.map(describeFlag).join("\n")}\n` },
    },
  },
});

export const adminFeatureFlagRuntimeTools = [
  getFeatureFlagTool,
  setFeatureFlagTool,
  listFeatureFlagsTool,
] as const;
