import type { HookScopesListOutput } from "@fragno-dev/backoffice-api/v0/hooks";
import {
  type BackofficeContextScope,
  backofficeWorkspaceOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeObjectScopePolicy,
  type BackofficeObjectRegistry,
  type BackofficeObjectScopeKind,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import {
  backofficeCapabilities,
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
  const organization = backofficeWorkspaceOrganization(scope);
  const capabilityContext = {
    objects,
    config,
    scope,
    ...(organization ? { organization } : {}),
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

export const backofficeCapabilitiesRuntimeTools = [hookScopesListTool] as const;

export const backofficeCapabilitiesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "backoffice-capabilities",
  tools: backofficeCapabilitiesRuntimeTools,
  isAvailable: (context: BackofficeCapabilitiesToolContext) => !!context.runtimes.backoffice,
});
