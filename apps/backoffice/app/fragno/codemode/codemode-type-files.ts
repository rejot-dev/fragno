import { generatePageSchemaDeclarations } from "@/artifacts/pages/declarations-generation";
import { generateBackofficeUiCatalogDeclarations } from "@/backoffice-ui/component-reference-generation";
import { codemodeStateToolFamily } from "@/fragno/runtime-tools/codemode-state-runtime";
import {
  createRuntimeToolReferences,
  renderCodemodeProviderNamespaceTypes,
  renderCodemodeScopedContextTypes,
  toRuntimeToolReference,
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

/**
 * Agents see these lines, not the files, until they read a file: like a skill description, each says
 * what its file declares, then when to read it. One per authored file and per visible provider.
 */
const CODEMODE_AUTHORED_REFERENCES = [
  {
    path: CODEMODE_WORKFLOW_AUTHORING_DTS_PATH,
    summary:
      "Workflow authoring: defineWorkflow, steps, sleeps, and waits. Read before defining a workflow.",
  },
  {
    path: CODEMODE_UI_DTS_PATH,
    summary: "Interface builder for generated UIs. Read before returning a ui.",
  },
  {
    path: CODEMODE_PAGE_DTS_PATH,
    summary: "Page builder: live queries bound to a ui. Read before writing a .page.js page.",
  },
];
const CODEMODE_PROVIDER_SUMMARIES: Record<string, string> = {
  state:
    "Files in /workspace and /static, and links that share them. Read for file work beyond searching, reading, and writing, or to share or move files.",
  blobs:
    "Large files kept outside /workspace, uploaded and downloaded through presigned storage URLs. Read to store or share a file too large for the workspace.",
  account:
    "Your own account: profile, organizations, invitations, authorized apps. Read when the user asks about themselves.",
  admin:
    "System administration: organizations, sign-ups, app registrations, OAuth clients, Marketplace features. Read in System scope.",
  org: "Current organization: name, members, invitations. Read to rename it, list members, or invite someone.",
  apps: "Installed apps: review, install, grants, action approval, uninstall. Read to install or manage an app.",
  hooks: "Durable hook queues. Read to debug stuck or retrying background delivery.",
  integrations:
    "External service connections: set up, inspect, run actions, generate typed clients. Read for any third-party service.",
  store: "Scope-owned key/value store. Read to keep small values across runs.",
  identity: "External identities bound to users. Read when a workflow acts for an external sender.",
  router:
    "Automation routes: event or schedule triggers that start or signal workflows, forward events, or notify agents. Read to automate anything later or recurring.",
  workflow:
    "Workflow instances: start saved workflows, check status and history, show a run to the user, send events, retry steps, terminate runs. Read to run or follow a workflow.",
  events:
    "Automation events: catalog, stored events and the routes they matched, firing, retries. Read to see what can trigger automations or why one did not act.",
  forms: "Schema-backed forms and their submissions. Read to create a form or read responses.",
  cloudflare:
    "Cloudflare Browser Run: screenshots, PDFs, crawls. Read to capture or crawl a page in a real browser.",
  web: "Web pages as content or Markdown, and files downloaded from URLs into the workspace. Read to fetch a web page or download a file.",
  models:
    "Classifiers for typed questions about data and images, typed extraction from PDFs and images, and image generation. Read to classify, read a PDF, or generate images.",
  otp: "Identity-claim links for external senders. Read to let an external user link their account.",
  pi: "Agents: define, prompt, stop, and read conversations. Read to work with an agent, including your own definition.",
  projects: "Projects in an organization or personal scope. Read to create or list projects.",
  reson8: "Reson8 speech-to-text. Read to transcribe audio.",
  sandbox: "Cloudflare sandboxes with a real shell. Read when work needs command-line tools.",
  js: "Saved JavaScript: check, run, build modules, and inspect codemode runs. Read to save, run, or debug a script file.",
  artifacts: "Page builds and their errors. Read to verify a page after writing it.",
  marketplace:
    "Marketplace packages: search, inspect, publish, feature. Read to find or publish a package.",
  packages:
    "Package installs into the workspace. Read to install a Marketplace package or list installed ones.",
};

// Discovery itself runs through these, so the agent has them before it has read anything.
const STATE_EXCERPT_TOOL_NAMES = ["readFile", "glob", "searchFiles", "writeFile"];

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

function renderReference({ path, summary }: { path: string; summary: string }) {
  if (!path.startsWith(`${CODEMODE_TYPES_DIR_PATH}/`)) {
    throw new Error(`Codemode reference must live under ${CODEMODE_TYPES_DIR_PATH}: ${path}`);
  }
  return `// ${summary}\n/// <reference path="${path}" />`;
}

function providerSummary(namespace: string) {
  const summary = CODEMODE_PROVIDER_SUMMARIES[namespace];
  if (summary === undefined) {
    throw new Error(
      `Codemode provider '${namespace}' needs a summary in CODEMODE_PROVIDER_SUMMARIES.`,
    );
  }
  return summary;
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
  return [
    "// Codemode globals. Each reference says when to read its declarations.",
    references,
    "",
    scopedContext,
  ].join("\n");
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
  const staleSummaries = Object.keys(CODEMODE_PROVIDER_SUMMARIES).filter(
    (namespace) => !runtimeReferencesByNamespace.has(namespace),
  );
  if (staleSummaries.length > 0) {
    throw new Error(`Codemode summaries name unknown providers: ${staleSummaries.join(", ")}.`);
  }
  const providers = [...runtimeReferencesByNamespace.entries()].map(
    ([namespace, namespaceReferences]) => ({
      namespace,
      path: typePathForNamespace(CODEMODE_PROVIDER_TYPES_DIR_PATH, namespace),
      summary: providerSummary(namespace),
      references: namespaceReferences,
    }),
  );
  const providerFiles = providers.map(({ namespace, path, summary, references }) => ({
    path,
    content: renderDtsContent(
      renderCodemodeProviderNamespaceTypes({ namespace, summary, references }),
    ),
  }));

  return [
    {
      path: CODEMODE_SYSTEM_DTS_PATH,
      content: renderDtsContent(
        renderCodemodeSystemTypes({
          references: [...CODEMODE_AUTHORED_REFERENCES, ...providers]
            .map(renderReference)
            .join("\n"),
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

/**
 * The state methods discovery needs, for the system prompt. A file would also be a declaration that
 * js.check loads beside the full state.d.ts, so the excerpt is rendered where it is used.
 */
export function renderCodemodeStateExcerpt() {
  const references = STATE_EXCERPT_TOOL_NAMES.map((name) => {
    const tool = codemodeStateToolFamily.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`The state excerpt names an unknown state tool: ${name}.`);
    }
    return toRuntimeToolReference(tool);
  });
  return renderCodemodeProviderNamespaceTypes({
    namespace: "state",
    summary: `Excerpt of ${typePathForNamespace(CODEMODE_PROVIDER_TYPES_DIR_PATH, "state")}: finding, reading, and writing files. Read that file for the rest.`,
    references,
  });
}
