import type {
  CapabilitiesListOutput,
  HookScopesListOutput,
} from "@fragno-dev/backoffice-api/v0/capabilities";
import {
  type BackofficeContextScope,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeObjectScopePolicy,
  type BackofficeObjectRegistry,
  type BackofficeObjectScopeKind,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import {
  backofficeCapabilities,
  getBackofficeCapabilityKind,
  listHookScopes,
  type BackofficeCapability,
  type BackofficeCapabilityContext,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  defineNoInputArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type BackofficeCapabilitiesRuntime = {
  listCapabilities(): Promise<CapabilitiesListOutput>;
  listHookScopes(): Promise<HookScopesListOutput>;
};

type BackofficeCapabilitiesToolContext = BackofficeToolContext<{
  backoffice?: BackofficeCapabilitiesRuntime;
}>;

const getRuntime = (context: BackofficeCapabilitiesToolContext) => {
  if (!context.runtimes.backoffice) {
    throw new Error("Backoffice capability runtime is not available in this execution context");
  }
  return context.runtimes.backoffice;
};

type OutputOptions = ReturnType<typeof readOutputOptions>;

const readOutput = (args: string[]) => readOutputOptions(parseCliTokens(args));
const shouldReturnData = (options: OutputOptions) =>
  options.format === "json" || Boolean(options.print);
const dataFormat = <T>(data: T) => ({ data });
const cell = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "-";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const renderTable = (headers: readonly string[], rows: readonly (readonly unknown[])[]) => {
  const normalizedRows = rows.map((row) => row.map(cell));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  return `${[
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.map(renderRow),
  ].join("\n")}\n`;
};

const formatCapabilitiesList = (data: CapabilitiesListOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["capability", "kind", "available", "configured", "healthy", "reason"],
          data.map((item) => [
            item.id,
            item.kind,
            item.available,
            item.configured,
            item.healthy ?? "-",
            item.reason ?? "",
          ]),
        ),
      };

const formatHookScopesList = (data: HookScopesListOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["fragment", "label", "capability", "kind", "configured", "healthy"],
          data.map((item) => [
            item.id,
            item.label,
            item.capabilityId,
            item.kind,
            item.configured ?? "-",
            item.healthy ?? "-",
          ]),
        ),
      };

const capabilitiesListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("capabilities.list"),
  namespace: "capabilities",
  name: "list",
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listCapabilities(),
  adapters: {
    bash: {
      command: "capabilities.list",
      help: {
        summary: "capabilities.list lists Backoffice capabilities and status.",
        options: [],
        examples: ["capabilities.list", "capabilities.list --format json"],
      },
      parse: defineNoInputArgsParser("capabilities.list"),
      outputOptions: readOutput,
      format: formatCapabilitiesList,
    },
  },
});

const hookScopesListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("hooks.scopes.list"),
  namespace: "hooks",
  name: "scopesList",
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listHookScopes(),
  adapters: {
    bash: {
      command: "hooks.scopes.list",
      help: {
        summary: "hooks.scopes.list lists hook scopes available to hooks.list --fragment.",
        options: [],
        examples: ["hooks.scopes.list", "hooks.scopes.list --format json"],
      },
      parse: defineNoInputArgsParser("hooks.scopes.list"),
      outputOptions: readOutput,
      format: formatHookScopesList,
    },
  },
});

export const createBackofficeCapabilitiesRuntime = ({
  objects,
  config,
  scope,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  scope: BackofficeContextScope;
}): BackofficeCapabilitiesRuntime => {
  const ownerOrgId = backofficeScopeOrganization(scope)?.orgId;
  const capabilityContext = {
    objects,
    config,
    scope,
    ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
  } as BackofficeCapabilityContext;
  const contextScopeKind = scope.kind === "system" ? "singleton" : scope.kind;
  const scopeSupported = (capability: BackofficeCapability) => {
    const objectBinding = capability.objectBinding;
    if (!objectBinding) {
      return capability.contributions.connection ? scope.kind === "org" : true;
    }

    const allowedScopes: readonly BackofficeObjectScopeKind[] =
      backofficeObjectScopePolicy[objectBinding];
    return allowedScopes.includes(contextScopeKind);
  };

  return {
    listCapabilities: async () =>
      await Promise.all(
        backofficeCapabilities.map(async (capability) => {
          const kind = getBackofficeCapabilityKind(capability);
          const connection = capability.contributions.connection;
          if (!scopeSupported(capability)) {
            return {
              id: capability.id,
              label: capability.label,
              kind,
              available: false,
              configured: false,
              healthy: false,
              reason: `${capability.label} is not available in ${scope.kind} context.`,
            };
          }
          if (!connection) {
            return {
              id: capability.id,
              label: capability.label,
              kind,
              available: true,
              configured: true,
              healthy: true,
            };
          }
          try {
            const status = await connection.getStatus(capabilityContext);
            return {
              id: capability.id,
              label: capability.label,
              kind,
              available: true,
              configured: status.configured,
              ...(status.verification ? { healthy: status.verification.ok } : {}),
              ...(status.missing?.length
                ? { reason: `missing: ${status.missing.join(", ")}` }
                : {}),
            };
          } catch (error) {
            return {
              id: capability.id,
              label: capability.label,
              kind,
              available: false,
              configured: false,
              healthy: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      ),
    listHookScopes: async () => {
      const statuses = new Map(
        (await Promise.all(
          backofficeCapabilities.map(async (capability) => {
            if (!scopeSupported(capability)) {
              return [capability.id, { configured: false, healthy: false }] as const;
            }
            const connection = capability.contributions.connection;
            if (!connection) {
              return [capability.id, { configured: true, healthy: true }] as const;
            }
            const status = await connection.getStatus(capabilityContext);
            return [
              capability.id,
              {
                configured: status.configured,
                healthy: status.verification?.ok,
              },
            ] as const;
          }),
        )) as readonly (readonly [string, { configured: boolean; healthy?: boolean }])[],
      );
      const capabilitiesById = new Map(
        backofficeCapabilities.map((capability) => [capability.id, capability]),
      );
      return listHookScopes()
        .filter((hookScope) => {
          const capability = capabilitiesById.get(hookScope.capabilityId);
          return capability ? scopeSupported(capability) : false;
        })
        .map((hookScope) => ({
          ...hookScope,
          ...statuses.get(hookScope.capabilityId),
        }));
    },
  };
};

export const backofficeCapabilitiesRuntimeTools = [
  capabilitiesListTool,
  hookScopesListTool,
] as const;

export const backofficeCapabilitiesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "backoffice-capabilities",
  tools: backofficeCapabilitiesRuntimeTools,
  isAvailable: (context: BackofficeCapabilitiesToolContext) => !!context.runtimes.backoffice,
});
