import { renderSystemGuidance } from "@/files";
import type { IFileSystem } from "@/files/interface";
import {
  backofficeCapabilities,
  type BackofficeCapabilityId,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  createMcpCodemodeReferences,
  type McpCodemodeServer,
} from "@/fragno/codemode/mcp-codemode-tools";
import {
  createRuntimeToolReferences,
  renderCodemodeProviderNamespaceTypes,
  renderCodemodeScopedContextTypes,
  renderCodemodeWorkflowTypes,
  type RuntimeToolReference,
} from "@/fragno/runtime-tools/reference";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";

export const CODEMODE_TYPES_DIR_PATH = "/workspace/codemode";
export const CODEMODE_SYSTEM_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/system.d.ts`;
export const CODEMODE_STATE_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/state.d.ts`;
export const CODEMODE_WORKFLOW_AUTHORING_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/workflow-authoring.d.ts`;
export const CODEMODE_PROVIDER_TYPES_DIR_PATH = `${CODEMODE_TYPES_DIR_PATH}/providers`;

export const renderCodemodeSystemPrompt = async ({ fileSystem }: { fileSystem: IFileSystem }) =>
  renderSystemGuidance({
    codemodeDts: await fileSystem.readFile(CODEMODE_SYSTEM_DTS_PATH),
    stateDts: await fileSystem.readFile(CODEMODE_STATE_DTS_PATH),
    workflowAuthoringDts: await fileSystem.readFile(CODEMODE_WORKFLOW_AUTHORING_DTS_PATH),
  });

const ALWAYS_AVAILABLE_CODEMODE_NAMESPACES = new Set([
  "capabilities",
  "connections",
  "store",
  "workflow",
  "hooks",
  "events",
  "event",
  "otp",
]);

const VALID_DECLARE_CONST_NAME = /^[A-Za-z_$][\w$]*$/u;
const VALID_PROVIDER_FILE_NAME = /^[A-Za-z0-9_$-]+$/u;

export type CodemodeTypeFile = {
  path: string;
  content: string;
};

const getCapabilityRuntimeNamespaces = (
  capabilityId: BackofficeCapabilityId,
): readonly string[] => {
  const capability = backofficeCapabilities.find((candidate) => candidate.id === capabilityId);
  return capability?.runtimeToolNamespaces ?? [];
};

const providerTypePathForNamespace = (namespace: string) => {
  if (!VALID_PROVIDER_FILE_NAME.test(namespace)) {
    throw new Error(`Cannot render codemode provider file for namespace '${namespace}'.`);
  }
  return `${CODEMODE_PROVIDER_TYPES_DIR_PATH}/${namespace}.d.ts`;
};

const renderReference = (path: string) => {
  if (!path.startsWith(`${CODEMODE_TYPES_DIR_PATH}/`)) {
    throw new Error(`Codemode reference must live under ${CODEMODE_TYPES_DIR_PATH}: ${path}`);
  }
  return `/// <reference path="${path}" />`;
};

const renderDtsContent = (...sections: string[]) => `${sections.join("\n")}\n`;

const getAllowedRuntimeToolReferences = ({
  configuredCapabilityIds = [],
  families,
}: {
  configuredCapabilityIds?: readonly BackofficeCapabilityId[];
  families: readonly BackofficeRuntimeToolFamily[];
}) => {
  const dynamicNamespaces = new Set<string>();
  for (const capabilityId of configuredCapabilityIds) {
    for (const namespace of getCapabilityRuntimeNamespaces(capabilityId)) {
      dynamicNamespaces.add(namespace);
    }
  }

  const allowedNamespaces = new Set([
    ...ALWAYS_AVAILABLE_CODEMODE_NAMESPACES,
    ...dynamicNamespaces,
  ]);

  return createRuntimeToolReferences({
    families: families
      .filter((family) => !family.hidden)
      .map((family) => ({
        ...family,
        tools: family.tools.filter(
          (tool) =>
            VALID_DECLARE_CONST_NAME.test(tool.namespace) && allowedNamespaces.has(tool.namespace),
        ),
      }))
      .filter((family) => family.tools.length > 0),
  });
};

const groupReferencesByNamespace = (references: readonly RuntimeToolReference[]) => {
  const byNamespace = new Map<string, RuntimeToolReference[]>();
  for (const reference of references) {
    byNamespace.set(reference.namespace, [
      ...(byNamespace.get(reference.namespace) ?? []),
      reference,
    ]);
  }
  return byNamespace;
};

export const createCodemodeTypeFiles = ({
  configuredCapabilityIds = [],
  families,
  mcpServers = [],
  stateTypes,
}: {
  configuredCapabilityIds?: readonly BackofficeCapabilityId[];
  families: readonly BackofficeRuntimeToolFamily[];
  mcpServers?: readonly McpCodemodeServer[];
  stateTypes: string;
}): CodemodeTypeFile[] => {
  const references = [
    ...getAllowedRuntimeToolReferences({ configuredCapabilityIds, families }),
    ...createMcpCodemodeReferences(mcpServers),
  ];
  const byNamespace = groupReferencesByNamespace(references);
  const providerFiles = [...byNamespace.entries()].map(([namespace, namespaceReferences]) => ({
    path: providerTypePathForNamespace(namespace),
    content: renderDtsContent(
      renderCodemodeProviderNamespaceTypes({ namespace, references: namespaceReferences }),
    ),
  }));

  const referencePaths = [
    CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
    ...providerFiles.map((file) => file.path),
  ];

  return [
    {
      path: CODEMODE_SYSTEM_DTS_PATH,
      content: renderDtsContent(
        ...referencePaths.map(renderReference),
        "",
        renderCodemodeScopedContextTypes([...byNamespace.keys()]),
      ),
    },
    {
      path: CODEMODE_STATE_DTS_PATH,
      content: renderDtsContent(stateTypes),
    },
    {
      path: CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
      content: renderDtsContent(renderCodemodeWorkflowTypes()),
    },
    ...providerFiles,
  ];
};
