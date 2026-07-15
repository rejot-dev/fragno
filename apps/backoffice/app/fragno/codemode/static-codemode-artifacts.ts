import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { emptyStaticFileArtifacts, type StaticFileArtifactsResolver } from "@/files/types";
import {
  backofficeCapabilities,
  type BackofficeCapabilityId,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  codemodeTypeFilesToStaticArtifacts,
  CODEMODE_SYSTEM_DTS_PATH,
  createCodemodeTypeFiles,
  type CodemodeTypeFile,
} from "@/fragno/codemode/codemode-dts";
import { createMcpCodemodeServers } from "@/fragno/codemode/mcp-codemode-tools";
import { STATE_TYPES } from "@/fragno/codemode/state-prompt";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

export type CodemodeStaticArtifactsResult = {
  path: typeof CODEMODE_SYSTEM_DTS_PATH;
  files: CodemodeTypeFile[];
  artifacts: Record<string, string>;
  configuredCapabilities: BackofficeCapabilityId[];
};

const isCapabilityBindingAvailable = (
  config: BackofficeRuntimeConfig,
  capabilityId: BackofficeCapabilityId,
) => {
  if (capabilityId in config.bindings) {
    return config.bindings[capabilityId as keyof BackofficeRuntimeConfig["bindings"]];
  }

  return true;
};

export const createCodemodeStaticArtifacts = async ({
  objects,
  config,
  orgId,
  origin = "https://backoffice.local",
  families = runtimeToolFamilies,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
  origin?: string;
  families?: readonly BackofficeRuntimeToolFamily[];
}): Promise<CodemodeStaticArtifactsResult> => {
  const configuredCapabilities: BackofficeCapabilityId[] = [];

  for (const capability of backofficeCapabilities) {
    if (capability.kind === "system") {
      configuredCapabilities.push(capability.id);
      continue;
    }

    if (!isCapabilityBindingAvailable(config, capability.id)) {
      continue;
    }

    const status = await capability.connection.getStatus({
      objects,
      config,
      scope: { kind: "org", orgId },
      orgId,
      origin,
    });
    if (status.configured) {
      configuredCapabilities.push(capability.id);
    }
  }

  const mcpServers = configuredCapabilities.includes("mcp")
    ? await createMcpRuntime(objects.mcp.forOrg(orgId))
        .listServers()
        .then(({ servers }) => createMcpCodemodeServers(servers))
    : [];

  const files = createCodemodeTypeFiles({
    configuredCapabilityIds: configuredCapabilities,
    families,
    mcpServers,
    stateTypes: STATE_TYPES,
  });

  return {
    path: CODEMODE_SYSTEM_DTS_PATH,
    files,
    artifacts: codemodeTypeFilesToStaticArtifacts(files),
    configuredCapabilities,
  };
};

export const createCodemodeStaticArtifactsResolver = ({
  objects,
  config,
  execution,
  origin,
  families,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  execution: BackofficeExecutionContext;
  origin?: string;
  families?: readonly BackofficeRuntimeToolFamily[];
}): StaticFileArtifactsResolver => {
  if (execution.scope.kind !== "org" && execution.scope.kind !== "project") {
    return emptyStaticFileArtifacts;
  }

  const orgId = execution.scope.orgId;
  return async () =>
    (
      await createCodemodeStaticArtifacts({
        objects,
        config,
        orgId,
        ...(origin ? { origin } : {}),
        ...(families ? { families } : {}),
      })
    ).artifacts;
};
