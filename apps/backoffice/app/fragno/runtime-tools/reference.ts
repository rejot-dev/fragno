import { zodSchemaToTypeScriptRender } from "@/lib/zod/zod-formatter";

import workflowAuthoringTypes from "../../../content/static/codemode/workflow-authoring.d.ts?raw";
import type { AutomationCommandOptionSpec } from "./automation-types";
import {
  createTrustedSystemBackofficeToolContext,
  getAvailableRuntimeTools,
  type AnyBackofficeRuntimeTool,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type RuntimeToolCodemodeReference = {
  providerName: string;
  toolName: string;
  description: string;
  inputTypeName: string;
  outputTypeName: string;
  inputType: string;
  outputType: string;
  inputTypeDeclarations?: string[];
  outputTypeDeclarations?: string[];
};

export type RuntimeToolBashReference = {
  command: string;
  summary: string;
  options: readonly AutomationCommandOptionSpec[];
  examples: readonly string[];
};

export type RuntimeToolReference = {
  id: string;
  namespace: string;
  description: string;
  codemode: RuntimeToolCodemodeReference;
  bash: RuntimeToolBashReference;
};

export type RuntimeToolFamilyReference = {
  namespace: string;
  tools: RuntimeToolReference[];
};

export type RuntimeToolFamilyReferenceTarget = "bash" | "codemode" | "dashboard";

export type DashboardCommandGroup = {
  namespace: string;
  commands: string[];
};

export const pascalCase = (value: string) =>
  value
    .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

const typeNameFor = (tool: AnyBackofficeRuntimeTool, suffix: "Input" | "Output") => {
  const override =
    suffix === "Input"
      ? tool.reference?.codemode?.inputTypeName
      : tool.reference?.codemode?.outputTypeName;
  return override ?? `${pascalCase(tool.namespace)}${pascalCase(tool.name)}${suffix}`;
};

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? "";

export const toRuntimeToolReference = (tool: AnyBackofficeRuntimeTool): RuntimeToolReference => {
  const inputTypeName = typeNameFor(tool, "Input");
  const outputTypeName = typeNameFor(tool, "Output");
  const inputType = zodSchemaToTypeScriptRender(tool.inputSchema, "input", {
    rootTypeName: inputTypeName,
  });
  const outputType = zodSchemaToTypeScriptRender(tool.outputSchema, "output", {
    rootTypeName: outputTypeName,
  });
  const bash = tool.adapters?.bash;

  if (!bash) {
    throw new Error(`Runtime tool '${tool.id}' is missing a bash adapter.`);
  }

  return {
    id: tool.id,
    namespace: tool.namespace,
    description: tool.description,
    codemode: {
      providerName: tool.namespace,
      toolName: tool.name,
      description: tool.reference?.codemode?.description ?? tool.description,
      inputTypeName,
      outputTypeName,
      inputType: inputType.type,
      outputType: outputType.type,
      inputTypeDeclarations: inputType.declarations,
      outputTypeDeclarations: outputType.declarations,
    },
    bash: {
      command: bash.command,
      summary: bash.help.summary,
      options: bash.help.options,
      examples: bash.help.examples ?? [],
    },
  };
};

export const createRuntimeToolReferenceContext = (): BackofficeToolContext =>
  createTrustedSystemBackofficeToolContext({
    runtimes: new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => ({}),
        has: () => true,
      },
    ),
  });

export const createRuntimeToolFamilyReference = ({
  family,
  context,
}: {
  family: BackofficeRuntimeToolFamily;
  context?: BackofficeToolContext;
}): RuntimeToolFamilyReference => {
  const tools =
    family.isAvailable && context && !family.isAvailable(context) ? [] : [...family.tools];
  return {
    namespace: family.namespace,
    tools: tools.map(toRuntimeToolReference),
  };
};

export const createRuntimeToolReferences = ({
  families,
  context,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  context?: BackofficeToolContext;
}): RuntimeToolReference[] => {
  const tools = context
    ? getAvailableRuntimeTools({ families, context })
    : families.flatMap((family) => [...family.tools]);
  return tools.map(toRuntimeToolReference);
};

const optionUsage = (option: AutomationCommandOptionSpec) => {
  const value = option.valueRequired ? ` <${option.valueName ?? "value"}>` : "";
  const usage = `--${option.name}${value}`;
  return option.required ? usage : `[${usage}]`;
};

const renderBashCommandReferenceMarkdown = (references: readonly RuntimeToolReference[]) => {
  const byNamespace = new Map<string, RuntimeToolReference[]>();
  for (const reference of references) {
    if (!reference.bash) {
      continue;
    }
    byNamespace.set(reference.namespace, [
      ...(byNamespace.get(reference.namespace) ?? []),
      reference,
    ]);
  }

  return [...byNamespace.entries()]
    .map(([namespace, namespaceReferences]) => {
      const commands = namespaceReferences.flatMap((reference) => {
        const bash = reference.bash;
        if (!bash) {
          return [];
        }
        const usage = bash.options.map(optionUsage).join(" ");
        const optionLines = bash.options.map(
          (option) => `  - --${option.name}: ${option.description}`,
        );
        const exampleLines = bash.examples.length
          ? ["  - Examples:", ...bash.examples.map((example) => `    - \`${example}\``)]
          : [];

        return [
          `- ${bash.command}${usage ? ` ${usage}` : ""}`,
          `  - ${firstLine(bash.summary)}`,
          ...optionLines,
          ...exampleLines,
        ].join("\n");
      });

      return [`### ${namespace}.*`, "", ...commands].join("\n");
    })
    .join("\n\n");
};

const sanitizeComment = (value: string) => value.replace(/\*\//g, "*\\/").trim();

const renderJSDoc = (value: string, spaces = 0) => {
  const prefix = " ".repeat(spaces);
  const lines = sanitizeComment(value).split("\n").filter(Boolean);
  if (!lines.length) {
    return "";
  }
  if (lines.length === 1) {
    return `${prefix}/** ${lines[0]} */`;
  }
  return [`${prefix}/**`, ...lines.map((line) => `${prefix} * ${line}`), `${prefix} */`].join("\n");
};

export const renderCodemodeWorkflowTypes = () => workflowAuthoringTypes.trimEnd();

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

const renderCodemodeProviderSection = ({
  namespace,
  references,
  renderedSharedTypeDeclarations,
}: {
  namespace: string;
  references: readonly RuntimeToolReference[];
  renderedSharedTypeDeclarations?: Set<string>;
}) => {
  const sharedTypeDeclarations = [
    ...new Set(
      references.flatMap((reference) => [
        ...(reference.codemode.inputTypeDeclarations ?? []),
        ...(reference.codemode.outputTypeDeclarations ?? []),
      ]),
    ),
  ].filter((declaration) => {
    if (!renderedSharedTypeDeclarations) {
      return true;
    }
    if (renderedSharedTypeDeclarations.has(declaration)) {
      return false;
    }
    renderedSharedTypeDeclarations.add(declaration);
    return true;
  });
  const typeDeclarations = [
    ...sharedTypeDeclarations,
    ...references.flatMap((reference) => {
      const { inputTypeName, outputTypeName, inputType, outputType } = reference.codemode;
      return [`type ${inputTypeName} = ${inputType};`, `type ${outputTypeName} = ${outputType};`];
    }),
  ];

  const methods = references.map((reference) => {
    const { toolName, description, inputTypeName, outputTypeName } = reference.codemode;
    return [
      renderJSDoc(description, 2),
      `  ${toolName}(input: ${inputTypeName}): Promise<${outputTypeName}>;`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  const providerTypeName = `${pascalCase(namespace)}CodemodeProvider`;

  return [
    `// ${namespace} tools`,
    `type ${providerTypeName} = {`,
    ...methods,
    `};`,
    `declare const ${namespace}: ${providerTypeName};`,
    "",
    ...typeDeclarations,
  ].join("\n");
};

export const renderCodemodeProviderNamespaceTypes = ({
  namespace,
  references,
}: {
  namespace: string;
  references: readonly RuntimeToolReference[];
}) => renderCodemodeProviderSection({ namespace, references });

export const renderCodemodeScopedContextTypes = (namespaces: readonly string[]) => {
  const scopedProviderEntries = namespaces.map(
    (namespace) => `  ${namespace}: ${pascalCase(namespace)}CodemodeProvider;`,
  );

  return [
    "// Scoped context handles target a selected Backoffice context.",
    "type BackofficeCodemodeScopedProviders = {",
    ...scopedProviderEntries,
    "};",
    "declare const context: {",
    "  /** Providers bound to the selected current context. */",
    "  readonly current: BackofficeCodemodeScopedProviders;",
    "  /** Providers bound to an organisation context. */",
    "  org(orgId: string): BackofficeCodemodeScopedProviders;",
    "  /** Providers bound to a user context. */",
    "  user(userId: string): BackofficeCodemodeScopedProviders;",
    "  /** Project contexts are reserved until the project model exists. */",
    "  project(projectId: string): BackofficeCodemodeScopedProviders;",
    "};",
  ].join("\n");
};

export const renderCodemodeProviderTypes = (references: readonly RuntimeToolReference[]) => {
  const byNamespace = groupReferencesByNamespace(references);
  const renderedSharedTypeDeclarations = new Set<string>();
  const providerSections = [...byNamespace.entries()].map(([namespace, namespaceReferences]) =>
    renderCodemodeProviderSection({
      namespace,
      references: namespaceReferences,
      renderedSharedTypeDeclarations,
    }),
  );

  return [
    "// ── Backoffice domain tool providers ───────────────────────────────────",
    ...providerSections,
    renderCodemodeScopedContextTypes([...byNamespace.keys()]),
  ].join("\n\n");
};

export const renderDashboardCommandGroups = (
  references: readonly RuntimeToolReference[],
): DashboardCommandGroup[] => {
  const groups = new Map<string, string[]>();
  for (const reference of references) {
    if (!reference.bash) {
      continue;
    }
    groups.set(reference.namespace, [
      ...(groups.get(reference.namespace) ?? []),
      reference.bash.command,
    ]);
  }
  return [...groups.entries()].map(([namespace, commands]) => ({
    namespace,
    commands,
  }));
};

export const stringifyRuntimeToolFamilyReference = ({
  reference,
  target,
}: {
  reference: RuntimeToolFamilyReference;
  target: RuntimeToolFamilyReferenceTarget;
}): string => {
  switch (target) {
    case "bash":
      return renderBashCommandReferenceMarkdown(reference.tools);
    case "codemode":
      return renderCodemodeProviderTypes(reference.tools);
    case "dashboard":
      return JSON.stringify(renderDashboardCommandGroups(reference.tools), null, 2);
  }

  throw new Error("Unsupported runtime tool family reference target.");
};
