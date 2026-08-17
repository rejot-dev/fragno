import { renderStaticGuidance } from "@/files/content/static";
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

import codemodeSystemTypesTemplate from "../../../content/static/codemode/system.d.ts?raw";

const CODEMODE_TYPES_DIR_PATH = "/static/codemode";
export const CODEMODE_SYSTEM_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/system.d.ts`;
const CODEMODE_WORKFLOW_AUTHORING_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/workflow-authoring.d.ts`;
const CODEMODE_PROVIDER_TYPES_DIR_PATH = `${CODEMODE_TYPES_DIR_PATH}/providers`;
const CODEMODE_SOURCE_TYPES_DIR_PATH = `${CODEMODE_TYPES_DIR_PATH}/sources`;

export const renderCodemodeSystemPrompt = async ({
  state,
}: {
  state: { readFile(path: string): Promise<string> };
}) =>
  renderStaticGuidance({
    codemodeDts: await state.readFile(CODEMODE_SYSTEM_DTS_PATH),
  });

const VALID_DECLARE_CONST_NAME = /^[A-Za-z_$][\w$]*$/u;
const VALID_PROVIDER_FILE_NAME = /^[A-Za-z0-9_$-]+$/u;

export type CodemodeTypeFile = {
  path: string;
  content: string;
};

export const codemodeTypeFilesToStaticArtifacts = (files: readonly CodemodeTypeFile[]) =>
  Object.fromEntries(
    files.map((file) => {
      if (!file.path.startsWith("/static/")) {
        throw new Error(`Codemode type file must live under /static: ${file.path}`);
      }
      return [file.path.slice("/static/".length), file.content];
    }),
  );

const typePathForNamespace = (directory: string, namespace: string) => {
  if (!VALID_PROVIDER_FILE_NAME.test(namespace)) {
    throw new Error(`Cannot render codemode provider file for namespace '${namespace}'.`);
  }
  return `${directory}/${namespace}.d.ts`;
};

const renderReference = (path: string) => {
  if (!path.startsWith(`${CODEMODE_TYPES_DIR_PATH}/`)) {
    throw new Error(`Codemode reference must live under ${CODEMODE_TYPES_DIR_PATH}: ${path}`);
  }
  return `/// <reference path="${path}" />`;
};

const renderDtsContent = (...sections: string[]) => `${sections.join("\n")}\n`;

const renderCodemodeSystemTypes = ({
  references,
  scopedContext,
}: {
  references: string;
  scopedContext: string;
}) =>
  codemodeSystemTypesTemplate
    .replace(
      "declare const __BACKOFFICE_CODEMODE_TEMPLATE__: unique symbol;\n\n/* __BACKOFFICE_CODEMODE_REFERENCES__ */",
      references,
    )
    .replace("/* __BACKOFFICE_CODEMODE_SCOPED_CONTEXT__ */", scopedContext)
    .trimEnd();

const getCodemodeRuntimeToolReferences = (families: readonly BackofficeRuntimeToolFamily[]) => {
  const visibleFamilies: BackofficeRuntimeToolFamily[] = [];

  for (const family of families) {
    if (family.hidden) {
      continue;
    }

    const tools = family.tools.filter((tool) => VALID_DECLARE_CONST_NAME.test(tool.namespace));
    if (tools.length > 0) {
      visibleFamilies.push({ ...family, tools });
    }
  }

  return createRuntimeToolReferences({ families: visibleFamilies });
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
  families,
  mcpServers = [],
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  mcpServers?: readonly McpCodemodeServer[];
}): CodemodeTypeFile[] => {
  const runtimeReferencesByNamespace = groupReferencesByNamespace(
    getCodemodeRuntimeToolReferences(families),
  );
  const sourceReferencesByNamespace = groupReferencesByNamespace(
    createMcpCodemodeReferences(mcpServers),
  );
  const providerFiles = [...runtimeReferencesByNamespace.entries()].map(
    ([namespace, namespaceReferences]) => ({
      path: typePathForNamespace(CODEMODE_PROVIDER_TYPES_DIR_PATH, namespace),
      content: renderDtsContent(
        renderCodemodeProviderNamespaceTypes({
          namespace,
          references: namespaceReferences,
        }),
      ),
    }),
  );
  const sourceFiles = [...sourceReferencesByNamespace.entries()].map(
    ([namespace, namespaceReferences]) => ({
      path: typePathForNamespace(CODEMODE_SOURCE_TYPES_DIR_PATH, namespace),
      content: renderDtsContent(
        renderCodemodeProviderNamespaceTypes({
          namespace,
          references: namespaceReferences,
        }),
      ),
    }),
  );
  const allNamespaces = [
    ...runtimeReferencesByNamespace.keys(),
    ...sourceReferencesByNamespace.keys(),
  ];
  const referencePaths = [
    CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
    ...providerFiles.map((file) => file.path),
    ...sourceFiles.map((file) => file.path),
  ];

  return [
    {
      path: CODEMODE_SYSTEM_DTS_PATH,
      content: renderDtsContent(
        renderCodemodeSystemTypes({
          references: referencePaths.map(renderReference).join("\n"),
          scopedContext: renderCodemodeScopedContextTypes(allNamespaces),
        }),
      ),
    },
    {
      path: CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
      content: renderDtsContent(renderCodemodeWorkflowTypes()),
    },
    ...providerFiles,
    ...sourceFiles,
  ];
};
