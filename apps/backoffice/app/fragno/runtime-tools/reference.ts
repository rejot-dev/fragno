import { z } from "zod";

import type { AutomationCommandOptionSpec } from "./automation-types";
import {
  getAvailableRuntimeTools,
  type AnyBackofficeRuntimeTool,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

type JsonSchemaObject = {
  type?: string | string[];
  description?: string;
  format?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  $ref?: string;
};

export type RuntimeToolCodemodeReference = {
  providerName: string;
  toolName: string;
  description: string;
  inputTypeName: string;
  outputTypeName: string;
  inputType: string;
  outputType: string;
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

const pascalCase = (value: string) =>
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

const literalToType = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      return "unknown";
  }
};

const renderUnion = (items: string[]) => {
  const unique = [...new Set(items)];
  return unique.length ? unique.join(" | ") : "unknown";
};

const indent = (value: string, spaces = 2) =>
  value
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");

const schemaJSDoc = (schema: JsonSchemaObject) => {
  if (schema.description?.trim()) {
    return schema.description.trim();
  }
  if (schema.type === "string" && schema.format === "date-time") {
    return "ISO 8601 datetime string.";
  }
  return undefined;
};

const renderSchemaJSDoc = (description: string) => {
  const lines = description.split("\n").filter(Boolean);
  if (lines.length === 1) {
    return `/** ${lines[0]} */`;
  }
  return ["/**", ...lines.map((line) => ` * ${line}`), " */"].join("\n");
};

const renderProperty = ({
  name,
  schema,
  required,
  depth,
}: {
  name: string;
  schema: JsonSchemaObject;
  required: boolean;
  depth: number;
}) => {
  const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  const property = `${key}${required ? "" : "?"}: ${schemaToTypeScript(schema, depth)};`;
  const jsDoc = schemaJSDoc(schema);
  return jsDoc ? `${renderSchemaJSDoc(jsDoc)}\n${property}` : property;
};

const schemaToTypeScript = (schema: JsonSchemaObject | undefined, depth = 0): string => {
  if (!schema || Object.keys(schema).length === 0 || schema.$ref) {
    return "unknown";
  }

  if (schema.const !== undefined) {
    return literalToType(schema.const);
  }

  if (schema.enum) {
    return renderUnion(schema.enum.map(literalToType));
  }

  if (schema.oneOf?.length) {
    return renderUnion(schema.oneOf.map((entry) => schemaToTypeScript(entry, depth)));
  }

  if (schema.anyOf?.length) {
    return renderUnion(schema.anyOf.map((entry) => schemaToTypeScript(entry, depth)));
  }

  if (schema.allOf?.length) {
    return schema.allOf.map((entry) => schemaToTypeScript(entry, depth)).join(" & ");
  }

  if (Array.isArray(schema.type)) {
    return renderUnion(schema.type.map((type) => schemaToTypeScript({ ...schema, type }, depth)));
  }

  switch (schema.type) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array": {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map((item) => schemaToTypeScript(item, depth)).join(", ")}]`;
      }
      const itemType = schemaToTypeScript(schema.items, depth);
      return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
    }
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const propertyLines = Object.entries(properties).map(([name, propertySchema]) =>
        renderProperty({
          name,
          schema: propertySchema,
          required: required.has(name),
          depth: depth + 1,
        }),
      );

      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        propertyLines.push(
          `[key: string]: ${schemaToTypeScript(schema.additionalProperties, depth + 1)};`,
        );
      } else if (schema.additionalProperties === true) {
        propertyLines.push("[key: string]: unknown;");
      }

      if (!propertyLines.length) {
        return "Record<string, unknown>";
      }

      return `{\n${indent(propertyLines.join("\n"), (depth + 1) * 2)}\n${" ".repeat(depth * 2)}}`;
    }
    default:
      return "unknown";
  }
};

const zodSchemaToTypeScript = (schema: z.ZodType, io: "input" | "output") => {
  try {
    return schemaToTypeScript(
      z.toJSONSchema(schema, {
        io,
        unrepresentable: "any",
        reused: "inline",
        override: ({ zodSchema, jsonSchema }) => {
          if ((zodSchema as unknown as z.ZodType)._zod.def.type === "date") {
            jsonSchema.type = "string";
            jsonSchema.format = "date-time";
          }
        },
      }) as JsonSchemaObject,
    );
  } catch {
    return "unknown";
  }
};

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? "";

export const toRuntimeToolReference = (tool: AnyBackofficeRuntimeTool): RuntimeToolReference => {
  const inputTypeName = typeNameFor(tool, "Input");
  const outputTypeName = typeNameFor(tool, "Output");
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
      inputType: zodSchemaToTypeScript(tool.inputSchema, "input"),
      outputType: zodSchemaToTypeScript(tool.outputSchema, "output"),
    },
    bash: {
      command: bash.command,
      summary: bash.help.summary,
      options: bash.help.options,
      examples: bash.help.examples ?? [],
    },
  };
};

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

export const renderBashCommandReferenceMarkdown = (references: readonly RuntimeToolReference[]) => {
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

export const renderCodemodeWorkflowTypes =
  () => `// ── Workflow helpers ──────────────────────────────────────────────────────
/** Relative duration. Numbers are milliseconds; strings use duration syntax such as "5 minutes", "30s", or "1 day". */
type WorkflowDuration = string | number;

type WorkflowEvent<TPayload = unknown> = {
  payload: Readonly<TPayload>;
  timestamp: Date;
  instanceId: string;
};

type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
};

type WorkflowStepEmission<TPayload = unknown> = {
  id: string;
  actor: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: TPayload;
  createdAt: Date;
};

type WorkflowStepEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
  consume(): void;
};

type WorkflowStepConsumeTx = {
  /** Persist an outbound workflow-authored step emission. */
  emit(payload: unknown): void;
  /** Emissions for this step that were already persisted before the current attempt started. */
  previousEmissions(): Promise<WorkflowStepEmission[]>;
};

type WorkflowStepTx = WorkflowStepConsumeTx & {
  /** Observe durable workflow events while this step is active. */
  onEvent<TPayload = unknown>(
    type: string,
    handler: (event: WorkflowStepEvent<TPayload>) => void | Promise<void>,
  ): () => void;
};

type WorkflowStep = {
  /** Run replay-safe work as a durable workflow step. */
  do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<TPayload = unknown>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: WorkflowStepConsumeTx,
        event: { type: string; payload: Readonly<TPayload>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ): Promise<{ type: string; payload: Readonly<TPayload>; timestamp: Date }>;
};

type CodemodeWorkflowDefinitionOptions = {
  /** Required remote workflow name used to identify this durable run. */
  name: string;
};

/**
 * Return defineWorkflow(...) from execCodeMode or a codemode automation script to schedule durable
 * workflow execution. The callback runs later with real workflow step controls.
 */
declare function defineWorkflow<TPayload = unknown, TOutput = unknown>(
  options: CodemodeWorkflowDefinitionOptions,
  run: (event: WorkflowEvent<TPayload>, step: WorkflowStep) => Promise<TOutput> | TOutput,
): unknown;`;

export const renderCodemodeProviderTypes = (references: readonly RuntimeToolReference[]) => {
  const byNamespace = new Map<string, RuntimeToolReference[]>();
  for (const reference of references) {
    byNamespace.set(reference.namespace, [
      ...(byNamespace.get(reference.namespace) ?? []),
      reference,
    ]);
  }

  const providerSections = [...byNamespace.entries()].map(([namespace, namespaceReferences]) => {
    const typeDeclarations = namespaceReferences.flatMap((reference) => {
      const { inputTypeName, outputTypeName, inputType, outputType } = reference.codemode;
      return [`type ${inputTypeName} = ${inputType};`, `type ${outputTypeName} = ${outputType};`];
    });

    const methods = namespaceReferences.map((reference) => {
      const { toolName, description, inputTypeName, outputTypeName } = reference.codemode;
      return [
        renderJSDoc(description, 2),
        `  ${toolName}(input: ${inputTypeName}): Promise<${outputTypeName}>;`,
      ]
        .filter(Boolean)
        .join("\n");
    });

    return [
      `// ${namespace} tools`,
      ...typeDeclarations,
      "",
      `declare const ${namespace}: {`,
      ...methods,
      `};`,
    ].join("\n");
  });

  return [
    "// ── Backoffice domain tool providers ───────────────────────────────────",
    ...providerSections,
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
  return [...groups.entries()].map(([namespace, commands]) => ({ namespace, commands }));
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
};
