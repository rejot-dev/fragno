import type { z } from "zod";

import { backofficeUiBuilderComponents } from "@/backoffice-ui/builder";
import { backofficeUiComponentDefinitions } from "@/backoffice-ui/catalog";
import {
  jsonSchemaToTypeScript,
  type JsonSchemaObject,
  zodSchemaToJsonSchema,
} from "@/lib/zod/zod-formatter";

type ConstrainedJsonSchema = JsonSchemaObject & {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function describeRange(minimum: number | undefined, maximum: number | undefined, unit: string) {
  const suffix = unit ? ` ${unit}` : "";
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum}-${maximum}${suffix}`;
  }
  if (minimum !== undefined) {
    return `at least ${minimum}${suffix}`;
  }
  if (maximum !== undefined) {
    return `at most ${maximum}${suffix}`;
  }
  return undefined;
}

function describeOwnLimits(schema: JsonSchemaObject) {
  const constrainedSchema = schema as ConstrainedJsonSchema;
  return [
    describeRange(constrainedSchema.minLength, constrainedSchema.maxLength, "characters"),
    describeRange(constrainedSchema.minimum, constrainedSchema.maximum, ""),
    describeRange(constrainedSchema.minItems, constrainedSchema.maxItems, "items"),
  ].filter((limit): limit is string => Boolean(limit));
}

/** Element and record-value limits have no property of their own to carry their JSDoc. */
function describePropertyLimits(schema: JsonSchemaObject, prefix = ""): string[] {
  const limits = describeOwnLimits(schema).map((limit) => `${prefix}${limit}`);
  if (schema.items && !Array.isArray(schema.items) && !schema.items.properties) {
    limits.push(...describePropertyLimits(schema.items, `${prefix}each item `));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const valuePrefix = prefix ? `${prefix.trimEnd()}'s values ` : "each value ";
    limits.push(...describePropertyLimits(schema.additionalProperties, valuePrefix));
  }
  return limits;
}

/** Copies the schema with each property's limits as its description, which renders as JSDoc. */
function withLimitDescriptions(schema: JsonSchemaObject): JsonSchemaObject {
  const annotated: JsonSchemaObject = { ...schema };
  if (schema.properties) {
    annotated.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, propertySchema]) => {
        const limits = describePropertyLimits(propertySchema).join("; ");
        const description = [propertySchema.description, limits].filter(Boolean).join(" ");
        const annotatedProperty = withLimitDescriptions(propertySchema);
        return [name, description ? { ...annotatedProperty, description } : annotatedProperty];
      }),
    );
  }
  if (schema.items && !Array.isArray(schema.items)) {
    annotated.items = withLimitDescriptions(schema.items);
  }
  if (schema.anyOf) {
    annotated.anyOf = schema.anyOf.map(withLimitDescriptions);
  }
  if (schema.oneOf) {
    annotated.oneOf = schema.oneOf.map(withLimitDescriptions);
  }
  return annotated;
}

function renderPropsType(propsSchema: z.ZodObject, depth: number) {
  const jsonSchema = zodSchemaToJsonSchema(propsSchema, "input");
  if (!jsonSchema) {
    throw new Error("Expected a props schema.");
  }
  return jsonSchemaToTypeScript(withLimitDescriptions(jsonSchema), depth);
}

const backofficeUiBuilderDeclarationTypes = `// Generated interface builder and component catalog. Props are strict: pass only the listed
// fields and stay within each documented limit.

/** An interface element. Create it with a ui.* function and pass the root to ui.render. */
type BackofficeUiElement = { readonly type: string };
/** Reads UI state; form.bind and form.is cover forms, so authored code rarely needs it. */
type BackofficeUiStateRead = { $state: string };
/** Binds an editable component's value prop to one form field. Create it with form.bind. */
type BackofficeUiBinding = { readonly $bindState: string };
declare const backofficeUiLiveValue: unique symbol;
/** A live value, such as a page query's rows; page.define binds it to the page's data. */
type BackofficeUiLive<TValue> = { readonly [backofficeUiLiveValue]: TValue };
type BackofficeUiProps<TProps> = {
  [TKey in keyof TProps]:
    | TProps[TKey]
    | BackofficeUiStateRead
    | BackofficeUiBinding
    | BackofficeUiLive<TProps[TKey]>;
};
type BackofficeUiComparison = {
  eq?: unknown;
  neq?: unknown;
  gt?: number | BackofficeUiStateRead;
  gte?: number | BackofficeUiStateRead;
  lt?: number | BackofficeUiStateRead;
  lte?: number | BackofficeUiStateRead;
  not?: true;
};
/** A visibility condition. Arrays and $and require every condition; $or requires one. */
type BackofficeUiCondition =
  | boolean
  | (BackofficeUiStateRead & BackofficeUiComparison)
  | BackofficeUiCondition[]
  | { $and: BackofficeUiCondition[] }
  | { $or: BackofficeUiCondition[] };
/** Collects one workflow event whose payload is the complete set of form fields. */
type BackofficeUiForm<TValues extends Record<string, unknown>> = {
  /** The event type. Await it with step.waitForEvent(name, { type: form.eventType }). */
  readonly eventType: string;
  /** Binds a field to an editable component's natural value prop. */
  bind(field: keyof TValues & string): BackofficeUiBinding;
  /** True while the field's current value matches the comparison; omit it to test truthiness. */
  is(field: keyof TValues & string, comparison?: BackofficeUiComparison): BackofficeUiCondition;
  /** The WorkflowEventButton that sends the complete form as the event payload. */
  submit(props: BackofficeUiFormSubmitProps): BackofficeUiElement;
};
/** The value of a result's top-level $ui field. */
type BackofficeUi = {
  version: 1;
  state: Record<string, unknown>;
  spec: { root: string; elements: Record<string, unknown> };
};`;

/** Declares the guest `ui` builder with the canonical props of every catalog component. */
export function generateBackofficeUiBuilderDeclarations() {
  const componentFunctions = backofficeUiBuilderComponents.map(
    ({ functionName, type, acceptsChildren }) => {
      const definition =
        backofficeUiComponentDefinitions[type as keyof typeof backofficeUiComponentDefinitions];
      const propsType = renderPropsType(definition.props, 1);
      const children = acceptsChildren ? ", children: BackofficeUiElement[]" : "";
      return `  /** Builds ${type}. ${definition.description} */
  ${functionName}(props: BackofficeUiProps<${propsType}>${children}): BackofficeUiElement;`;
    },
  );
  const submitPropsType = renderPropsType(
    backofficeUiComponentDefinitions.WorkflowEventButton.props.omit({
      eventType: true,
      payload: true,
    }),
    0,
  );

  return `${backofficeUiBuilderDeclarationTypes}
type BackofficeUiFormSubmitProps = ${submitPropsType};

declare const ui: {
${componentFunctions.join("\n")}
  /** Shows the element only while the condition holds. */
  when(condition: BackofficeUiCondition, element: BackofficeUiElement): BackofficeUiElement;
  /** Declares the one form an interface may collect; initial names every field. */
  form<TValues extends Record<string, unknown>>(
    eventType: string,
    initial: TValues,
  ): BackofficeUiForm<TValues>;
  /** Renders the element tree, assigning element ids and form state. */
  render(root: BackofficeUiElement): BackofficeUi;
};
`;
}
