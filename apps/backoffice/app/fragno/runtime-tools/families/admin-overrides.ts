import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  backofficePublicScopeCodec,
  parseBackofficeScopeSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { entitlementDefinitions, entitlementKeySchema } from "@/fragno/entitlements/definitions";
import { featureFlagKeySchema } from "@/fragno/feature-flags/definitions";
import type { OverrideKind } from "@/fragno/overrides/definition";

import type {
  AutomationCommandExecutionResult,
  AutomationCommandOutputOptions,
} from "../automation-types";
import { defineCliArgsParser } from "../bash-cli";
import { defineBackofficeRuntimeTool } from "../runtime-tools";
import { requireSystemAdminRuntime, type AdminSystemToolContext } from "./admin-system-runtime";

/** An override's value in a scope, its scopes named as `--scope` names them. */
export type AdminOverride = {
  key: string;
  description: string;
  default: unknown;
  value: unknown;
  overrides: { scope: string; value: unknown }[];
};

// Overrides on user and system scopes change what people may do, such as whom their address emails,
// so they need user management as well as organization management, as usage limits do.
const overridePermissions = [
  BACKOFFICE_PERMISSION.admin.organizationsManage,
  BACKOFFICE_PERMISSION.admin.usersManage,
] as const;

const scopeFormat =
  "system, org:<slug>, user:<userId>, app:org:<slug>:<appId>, or project:org:<slug>:<projectId>";
const scopeOption = {
  name: "scope",
  required: true,
  valueRequired: true,
  valueName: "scope",
  description: scopeFormat,
};
const keyOption = {
  name: "key",
  required: true,
  valueRequired: true,
  valueName: "key",
  description: "The key, as list shows it",
};
const stringArg = { kind: "string", required: true } as const;

/** Terminal output reads as text unless JSON was asked for. */
function formatted<TData>(render: (data: TData) => string) {
  return (data: TData, options: AutomationCommandOutputOptions): AutomationCommandExecutionResult =>
    options.format === "json" || options.print ? { data } : { data, stdout: `${render(data)}\n` };
}

function parseScope(scope: string) {
  return parseBackofficeScopeSegment(scope, backofficePublicScopeCodec);
}

/** Get, set, clear, and list commands for one kind of override, such as `admin.feature-flags.*`. */
function adminOverrideTools(spec: {
  kind: OverrideKind;
  /** Names the commands, e.g. `feature-flags` for `admin.feature-flags.set`. */
  command: string;
  /** Names the Codemode methods, e.g. `featureFlags` for `admin.featureFlagsSet`. */
  method: string;
  noun: string;
  keySchema: z.ZodType<string, string>;
  /** Read from the terminal as text, so every kind takes its value as a string. */
  valueInput: z.ZodType<string, string>;
  valueInputDescription: string;
  toValue(input: string): unknown;
  /** The values the kind's definitions accept; typed `unknown` here, described exactly at runtime. */
  value: z.ZodType;
  formatValue(value: unknown): string;
  /** A scope this kind's example key accepts, for the help examples. */
  example: { scope: string; key: string; value: string };
}) {
  const statusSchema = z.strictObject({
    key: spec.keySchema,
    description: z.string(),
    default: spec.value,
    value: spec.value,
    overrides: z
      .array(z.strictObject({ scope: z.string(), value: spec.value }))
      .describe(
        "Overrides on the scope and the scopes that own it, most specific first; the first decides.",
      ),
  });
  const scopeFields = { scope: z.string().trim().min(1).describe(scopeFormat) };
  const keyFields = { ...scopeFields, key: spec.keySchema };
  const describe = (status: z.output<typeof statusSchema>) => {
    const [deciding] = status.overrides;
    const decidedBy = deciding ? `set on ${deciding.scope}` : "default";
    return `${status.key}: ${spec.formatValue(status.value)} (${decidedBy}, default ${spec.formatValue(status.default)}) — ${status.description}`;
  };
  const formatOne = formatted(describe);
  const prefix = `admin.${spec.command}`;
  const admin = (context: AdminSystemToolContext) =>
    requireSystemAdminRuntime(context, `${spec.noun}s`);

  return [
    defineBackofficeRuntimeTool({
      id: `${prefix}.get`,
      namespace: "admin",
      name: `${spec.method}Get`,
      activity: { label: `Get ${spec.noun}`, target: ({ scope, key }) => `${key} in ${scope}` },
      description: `Get one ${spec.noun}'s value in a scope, its default, and the overrides that decide it.`,
      requiredPermissions: overridePermissions,
      inputSchema: z.strictObject(keyFields),
      outputSchema: statusSchema,
      execute: ({ scope, key }, context: AdminSystemToolContext) =>
        admin(context).getOverride({ kind: spec.kind, scope: parseScope(scope), key }),
      adapters: {
        bash: {
          command: `${prefix}.get`,
          help: {
            summary: `Get a ${spec.noun} in a scope.`,
            options: [scopeOption, keyOption],
            examples: [`${prefix}.get --scope ${spec.example.scope} --key ${spec.example.key}`],
          },
          parse: defineCliArgsParser(`${prefix}.get`, { scope: stringArg, key: stringArg }),
          format: formatOne,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: `${prefix}.set`,
      namespace: "admin",
      name: `${spec.method}Set`,
      activity: { label: `Set ${spec.noun}`, target: ({ scope, key }) => `${key} in ${scope}` },
      description: `Override a ${spec.noun} on a scope. The most specific override on a scope's chain decides: project, then app, then organization or user, then system.`,
      requiredPermissions: overridePermissions,
      inputSchema: z.strictObject({
        ...keyFields,
        value: spec.valueInput.describe(spec.valueInputDescription),
      }),
      outputSchema: statusSchema,
      execute: ({ scope, key, value }, context: AdminSystemToolContext) =>
        admin(context).setOverride({
          kind: spec.kind,
          scope: parseScope(scope),
          key,
          value: spec.toValue(value),
        }),
      adapters: {
        bash: {
          command: `${prefix}.set`,
          help: {
            summary: `Override a ${spec.noun} on a scope.`,
            options: [
              scopeOption,
              keyOption,
              {
                name: "value",
                required: true,
                valueRequired: true,
                valueName: "value",
                description: spec.valueInputDescription,
              },
            ],
            examples: [
              `${prefix}.set --scope ${spec.example.scope} --key ${spec.example.key} --value ${spec.example.value}`,
            ],
          },
          parse: defineCliArgsParser(`${prefix}.set`, {
            scope: stringArg,
            key: stringArg,
            value: stringArg,
          }),
          format: formatOne,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: `${prefix}.clear`,
      namespace: "admin",
      name: `${spec.method}Clear`,
      activity: { label: `Clear ${spec.noun}`, target: ({ scope, key }) => `${key} in ${scope}` },
      description: `Clear a scope's ${spec.noun} override, so the scopes that own it decide again.`,
      requiredPermissions: overridePermissions,
      inputSchema: z.strictObject(keyFields),
      outputSchema: statusSchema,
      execute: ({ scope, key }, context: AdminSystemToolContext) =>
        admin(context).clearOverride({ kind: spec.kind, scope: parseScope(scope), key }),
      adapters: {
        bash: {
          command: `${prefix}.clear`,
          help: {
            summary: `Clear a scope's ${spec.noun} override.`,
            options: [scopeOption, keyOption],
            examples: [`${prefix}.clear --scope ${spec.example.scope} --key ${spec.example.key}`],
          },
          parse: defineCliArgsParser(`${prefix}.clear`, { scope: stringArg, key: stringArg }),
          format: formatOne,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: `${prefix}.list`,
      namespace: "admin",
      name: `${spec.method}List`,
      activity: { label: `List ${spec.noun}s`, target: ({ scope }) => scope },
      description: `List the ${spec.noun}s and their values in a scope.`,
      requiredPermissions: overridePermissions,
      inputSchema: z.strictObject(scopeFields),
      outputSchema: z.array(statusSchema),
      execute: ({ scope }, context: AdminSystemToolContext) =>
        admin(context).listOverrides({ kind: spec.kind, scope: parseScope(scope) }),
      adapters: {
        bash: {
          command: `${prefix}.list`,
          help: {
            summary: `List the ${spec.noun}s in a scope.`,
            options: [scopeOption],
            examples: [`${prefix}.list --scope ${spec.example.scope}`],
          },
          parse: defineCliArgsParser(`${prefix}.list`, { scope: stringArg }),
          format: formatted((data: z.output<typeof statusSchema>[]) =>
            data.map(describe).join("\n"),
          ),
        },
      },
    }),
  ] as const;
}

export const adminOverrideRuntimeTools = [
  ...adminOverrideTools({
    kind: "feature-flag",
    command: "feature-flags",
    method: "featureFlags",
    noun: "feature flag",
    keySchema: featureFlagKeySchema,
    valueInput: z.enum(["on", "off"]),
    valueInputDescription: "on or off",
    toValue: (value) => value === "on",
    value: z.boolean(),
    formatValue: (value) => (value ? "on" : "off"),
    example: { scope: "org:acme", key: "scope-probe", value: "on" },
  }),
  ...adminOverrideTools({
    kind: "entitlement",
    command: "entitlements",
    method: "entitlements",
    noun: "entitlement",
    keySchema: entitlementKeySchema,
    valueInput: z.string().trim().min(1),
    valueInputDescription: "A value the entitlement accepts, as list describes it",
    toValue: (value) => value,
    // Every value some entitlement accepts; set checks the value against its own entitlement.
    value: z.union(Object.values(entitlementDefinitions).map(({ schema }) => schema)),
    formatValue: (value) => JSON.stringify(value),
    example: { scope: "user:<userId>", key: "email.recipients", value: "anyone" },
  }),
] as const;
