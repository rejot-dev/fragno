import { generatePageSchemaDeclarations } from "@/artifacts/pages/declarations-generation";
import { generateBackofficeUiCatalogDeclarations } from "@/backoffice-ui/component-reference-generation";
import {
  createRuntimeToolReferences,
  renderCodemodeProviderNamespaceTypes,
  renderCodemodeScopedContextTypes,
  type RuntimeToolReference,
} from "@/fragno/runtime-tools/reference";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";

const CODEMODE_TYPES_DIR_PATH = "/static/codemode";
export const CODEMODE_SYSTEM_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/system.d.ts`;
export const CODEMODE_WORKFLOW_AUTHORING_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/workflow-authoring.d.ts`;
const CODEMODE_UI_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/ui.d.ts`;
const CODEMODE_UI_CATALOG_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/ui-catalog.d.ts`;
const CODEMODE_PAGE_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/page.d.ts`;
const CODEMODE_PAGE_SCHEMA_DTS_PATH = `${CODEMODE_TYPES_DIR_PATH}/page-schema.d.ts`;
const CODEMODE_PROVIDER_TYPES_DIR_PATH = `${CODEMODE_TYPES_DIR_PATH}/providers`;

const VALID_DECLARE_CONST_NAME = /^[A-Za-z_$][\w$]*$/u;
const VALID_PROVIDER_FILE_NAME = /^[A-Za-z0-9_$-]+$/u;

export type CodemodeTypeFile = {
  path: string;
  content: string;
};

function typePathForNamespace(directory: string, namespace: string) {
  if (!VALID_PROVIDER_FILE_NAME.test(namespace)) {
    throw new Error(`Cannot render codemode provider file for namespace '${namespace}'.`);
  }
  return `${directory}/${namespace}.d.ts`;
}

function renderReference(path: string) {
  if (!path.startsWith(`${CODEMODE_TYPES_DIR_PATH}/`)) {
    throw new Error(`Codemode reference must live under ${CODEMODE_TYPES_DIR_PATH}: ${path}`);
  }
  return `/// <reference path="${path}" />`;
}

function renderDtsContent(...sections: string[]) {
  return `${sections.join("\n")}\n`;
}

function renderCodemodeSystemTypes({
  references,
  scopedContext,
}: {
  references: string;
  scopedContext: string;
}) {
  return [references, "", scopedContext].join("\n");
}

function getCodemodeRuntimeToolReferences(families: readonly BackofficeRuntimeToolFamily[]) {
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
}

function groupReferencesByNamespace(references: readonly RuntimeToolReference[]) {
  const byNamespace = new Map<string, RuntimeToolReference[]>();
  for (const reference of references) {
    byNamespace.set(reference.namespace, [
      ...(byNamespace.get(reference.namespace) ?? []),
      reference,
    ]);
  }
  return byNamespace;
}

/** Generates deployment-static codemode system and provider declaration files. */
export function createCodemodeStaticTypeFiles({
  families,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
}): CodemodeTypeFile[] {
  const runtimeReferencesByNamespace = groupReferencesByNamespace(
    getCodemodeRuntimeToolReferences(families),
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
  const referencePaths = [
    CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
    CODEMODE_UI_DTS_PATH,
    CODEMODE_PAGE_DTS_PATH,
    ...providerFiles.map((file) => file.path),
  ];

  return [
    {
      path: CODEMODE_SYSTEM_DTS_PATH,
      content: renderDtsContent(
        renderCodemodeSystemTypes({
          references: referencePaths.map(renderReference).join("\n"),
          scopedContext: renderCodemodeScopedContextTypes([...runtimeReferencesByNamespace.keys()]),
        }),
      ),
    },
    { path: CODEMODE_UI_CATALOG_DTS_PATH, content: generateBackofficeUiCatalogDeclarations() },
    { path: CODEMODE_PAGE_SCHEMA_DTS_PATH, content: generatePageSchemaDeclarations() },
    ...providerFiles,
  ];
}

/** Generates the complete codemode declaration set for tests and in-memory consumers. */
export function createCodemodeTypeFiles({
  families,
  authoredTypes,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  /** The declarations written by hand rather than generated. */
  authoredTypes: { workflowAuthoring: string; ui: string; page: string };
}): CodemodeTypeFile[] {
  return [
    ...createCodemodeStaticTypeFiles({ families }),
    ...[
      { path: CODEMODE_WORKFLOW_AUTHORING_DTS_PATH, content: authoredTypes.workflowAuthoring },
      { path: CODEMODE_UI_DTS_PATH, content: authoredTypes.ui },
      { path: CODEMODE_PAGE_DTS_PATH, content: authoredTypes.page },
    ].map(({ path, content }) => ({ path, content: renderDtsContent(content.trimEnd()) })),
  ];
}
