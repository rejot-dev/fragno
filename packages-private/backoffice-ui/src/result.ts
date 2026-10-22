import { z } from "zod";

import { validateSpec, VisibilityConditionSchema, type Spec } from "@json-render/core";

import {
  backofficeUiCatalog,
  backofficeUiComponentDefinitions,
  type BackofficeUiSpec,
} from "./catalog";
import { describeInvalidGeneratedProps, validateGeneratedProps } from "./generated-props";

export const BACKOFFICE_UI_LIMITS = {
  elements: 128,
  childrenPerElement: 32,
  childReferences: 512,
  depth: 24,
} as const;

export type BackofficeUiResultV1 = Record<string, unknown> & {
  $ui: {
    version: 1;
    state: Record<string, unknown>;
    spec: BackofficeUiSpec;
  };
};

export type BackofficeUiValidationErrorCode =
  | "unsupported-version"
  | "invalid-contract"
  | "unsupported-field"
  | "element-count"
  | "child-count"
  | "missing-root"
  | "missing-child"
  | "unknown-slot"
  | "unknown-component"
  | "invalid-props"
  | "invalid-visibility"
  | "cyclic-children"
  | "depth";

export type BackofficeUiParseResult =
  | { kind: "ordinary" }
  | { kind: "invalid"; code: BackofficeUiValidationErrorCode; message: string }
  | { kind: "valid"; value: BackofficeUiResultV1 };

const generatedUiElementSchema = z.strictObject({
  type: z.string(),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()),
  // Named slots of the component, such as a row's expanded content; children fill the default one.
  slots: z.record(z.string(), z.array(z.string())).optional(),
  visible: z.unknown().optional(),
  // Children render once per item of the array at statePath, or of the item field around them.
  repeat: z
    .strictObject({
      statePath: z.union([z.string(), z.strictObject({ $item: z.string() })]),
    })
    .optional(),
});

const generatedUiSpecSchema = z.strictObject({
  root: z.string(),
  elements: z.record(z.string(), generatedUiElementSchema),
});

const backofficeUiResultEnvelopeSchema = z.looseObject({
  $ui: z.strictObject({
    version: z.literal(1),
    state: z.record(z.string(), z.unknown()),
    spec: generatedUiSpecSchema,
  }),
});

const specFieldNames = new Set(["root", "elements"]);
const elementFieldNames = new Set(["type", "props", "children", "slots", "visible", "repeat"]);

/** Every element an element renders, in its children and its named slots. */
function childKeysOf(element: { children?: string[]; slots?: Record<string, string[]> }): string[] {
  return [...(element.children ?? []), ...Object.values(element.slots ?? {}).flat()];
}

export function parseBackofficeUiResult(value: unknown): BackofficeUiParseResult {
  if (!isRecord(value) || !Object.hasOwn(value, "$ui")) {
    return { kind: "ordinary" };
  }

  const rawUi = value.$ui;
  if (!isRecord(rawUi)) {
    return invalidResult("invalid-contract", "$ui must be an object.");
  }
  if (rawUi.version !== 1) {
    return invalidResult("unsupported-version", "Unsupported $ui version. Expected version 1.");
  }

  const unsupportedField = findUnsupportedSpecField(rawUi.spec);
  if (unsupportedField) {
    return invalidResult("unsupported-field", unsupportedField);
  }

  const envelopeResult = backofficeUiResultEnvelopeSchema.safeParse(value);
  if (!envelopeResult.success) {
    return invalidResult(
      "invalid-contract",
      "$ui must contain object state and a flat root/elements specification.",
    );
  }

  const rawSpec = envelopeResult.data.$ui.spec;
  const elementEntries = Object.entries(rawSpec.elements);
  if (elementEntries.length > BACKOFFICE_UI_LIMITS.elements) {
    return invalidResult(
      "element-count",
      `Generated UI exceeds the ${BACKOFFICE_UI_LIMITS.elements}-element limit.`,
    );
  }

  let childReferenceCount = 0;
  for (const [elementKey, element] of elementEntries) {
    const childCount = childKeysOf(element).length;
    if (childCount > BACKOFFICE_UI_LIMITS.childrenPerElement) {
      return invalidResult(
        "child-count",
        `Element "${elementKey}" exceeds the ${BACKOFFICE_UI_LIMITS.childrenPerElement}-child limit.`,
      );
    }
    childReferenceCount += childCount;
  }
  if (childReferenceCount > BACKOFFICE_UI_LIMITS.childReferences) {
    return invalidResult(
      "child-count",
      `Generated UI exceeds the ${BACKOFFICE_UI_LIMITS.childReferences}-child-reference limit.`,
    );
  }

  if (!Object.hasOwn(rawSpec.elements, rawSpec.root)) {
    return invalidResult("missing-root", `Generated UI root "${rawSpec.root}" does not exist.`);
  }

  // Prop problems are independent per element, so report all of them in one pass.
  const invalidPropsMessages: string[] = [];
  for (const [elementKey, element] of elementEntries) {
    for (const childKey of childKeysOf(element)) {
      if (!Object.hasOwn(rawSpec.elements, childKey)) {
        return invalidResult(
          "missing-child",
          `Element "${elementKey}" references missing child "${childKey}".`,
        );
      }
    }

    if (!Object.hasOwn(backofficeUiComponentDefinitions, element.type)) {
      return invalidResult(
        "unknown-component",
        `Element "${elementKey}" uses unsupported component "${element.type}".`,
      );
    }

    const componentName = element.type as keyof typeof backofficeUiComponentDefinitions;
    const componentDefinition = backofficeUiComponentDefinitions[componentName];
    const namedSlots = (componentDefinition.slots as readonly string[]).filter(
      (slot) => slot !== "default",
    );
    const unknownSlot = Object.keys(element.slots ?? {}).find((slot) => !namedSlots.includes(slot));
    if (unknownSlot !== undefined) {
      return invalidResult(
        "unknown-slot",
        `Element "${elementKey}" fills slot "${unknownSlot}", which ${componentName} does not have.`,
      );
    }
    if (!validateGeneratedProps(componentDefinition.props, element.props)) {
      invalidPropsMessages.push(
        `Element "${elementKey}" has invalid props for ${componentName}: ${describeInvalidGeneratedProps(componentDefinition.props, element.props)}.`,
      );
    }
    if (
      element.visible !== undefined &&
      !VisibilityConditionSchema.safeParse(element.visible).success
    ) {
      return invalidResult(
        "invalid-visibility",
        `Element "${elementKey}" has an invalid visibility condition.`,
      );
    }
  }

  if (invalidPropsMessages.length > 0) {
    return invalidResult("invalid-props", invalidPropsMessages.join(" "));
  }

  const childGraph = analyzeChildGraph(rawSpec as Spec);
  if (childGraph.cyclic) {
    return invalidResult(
      "cyclic-children",
      "Generated UI child references must not contain cycles.",
    );
  }
  if (childGraph.depth > BACKOFFICE_UI_LIMITS.depth) {
    return invalidResult(
      "depth",
      `Generated UI exceeds the ${BACKOFFICE_UI_LIMITS.depth}-level depth limit.`,
    );
  }

  const specResult = backofficeUiCatalog.validate(rawSpec);
  if (!specResult.success || !specResult.data) {
    return invalidResult("invalid-contract", "Generated UI does not match the Backoffice catalog.");
  }

  const spec = specResult.data as Spec;
  const graph = validateSpec(spec);
  if (!graph.valid) {
    const errors = graph.issues.filter(({ severity }) => severity === "error");
    return invalidResult(
      "invalid-contract",
      `Generated UI contains an invalid element graph: ${errors.map(({ message }) => message).join(" ")}`,
    );
  }

  return {
    kind: "valid",
    value: {
      ...envelopeResult.data,
      $ui: {
        version: 1,
        state: envelopeResult.data.$ui.state,
        spec,
      },
    },
  };
}

function invalidResult(
  code: BackofficeUiValidationErrorCode,
  message: string,
): BackofficeUiParseResult {
  return { kind: "invalid", code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findUnsupportedSpecField(spec: unknown) {
  if (!isRecord(spec)) {
    return null;
  }

  const unsupportedSpecField = Object.keys(spec).find((field) => !specFieldNames.has(field));
  if (unsupportedSpecField) {
    return `Generated UI uses unsupported spec field "${unsupportedSpecField}".`;
  }
  if (!isRecord(spec.elements)) {
    return null;
  }

  for (const [elementKey, element] of Object.entries(spec.elements)) {
    if (!isRecord(element)) {
      continue;
    }
    const unsupportedElementField = Object.keys(element).find(
      (field) => !elementFieldNames.has(field),
    );
    if (unsupportedElementField) {
      return `Element "${elementKey}" uses unsupported field "${unsupportedElementField}".`;
    }
  }

  return null;
}

function analyzeChildGraph(spec: Spec) {
  const incomingReferenceCount = new Map(
    Object.keys(spec.elements).map((elementKey) => [elementKey, 0]),
  );
  const elementDepth = new Map(Object.keys(spec.elements).map((elementKey) => [elementKey, 1]));

  for (const element of Object.values(spec.elements)) {
    for (const childKey of childKeysOf(element)) {
      incomingReferenceCount.set(childKey, (incomingReferenceCount.get(childKey) ?? 0) + 1);
    }
  }

  const pendingElementKeys: string[] = [];
  for (const [elementKey, referenceCount] of incomingReferenceCount) {
    if (referenceCount === 0) {
      pendingElementKeys.push(elementKey);
    }
  }
  let processedElementCount = 0;
  let depth = 0;

  while (pendingElementKeys.length > 0) {
    const elementKey = pendingElementKeys.pop();
    if (!elementKey) {
      continue;
    }

    processedElementCount += 1;
    const currentDepth = elementDepth.get(elementKey) ?? 1;
    depth = Math.max(depth, currentDepth);

    const element = spec.elements[elementKey];
    for (const childKey of element ? childKeysOf(element) : []) {
      elementDepth.set(childKey, Math.max(elementDepth.get(childKey) ?? 1, currentDepth + 1));
      const nextCount = (incomingReferenceCount.get(childKey) ?? 0) - 1;
      incomingReferenceCount.set(childKey, nextCount);
      if (nextCount === 0) {
        pendingElementKeys.push(childKey);
      }
    }
  }

  return {
    cyclic: processedElementCount !== incomingReferenceCount.size,
    depth,
  };
}
