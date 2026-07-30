import { z } from "zod";

import { validateSpec, VisibilityConditionSchema, type Spec } from "@json-render/core";

import {
  backofficeUiCatalog,
  backofficeUiComponentDefinitions,
  type BackofficeUiSpec,
} from "./catalog";
import { validateGeneratedProps } from "./generated-props";

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
  visible: z.unknown().optional(),
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
const elementFieldNames = new Set(["type", "props", "children", "visible"]);

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
    if (element.children.length > BACKOFFICE_UI_LIMITS.childrenPerElement) {
      return invalidResult(
        "child-count",
        `Element "${elementKey}" exceeds the ${BACKOFFICE_UI_LIMITS.childrenPerElement}-child limit.`,
      );
    }
    childReferenceCount += element.children.length;
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

  for (const [elementKey, element] of elementEntries) {
    for (const childKey of element.children) {
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
    if (!validateGeneratedProps(componentDefinition.props, element.props)) {
      return invalidResult(
        "invalid-props",
        `Element "${elementKey}" has invalid props for ${componentName}.`,
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
  if (!validateSpec(spec).valid) {
    return invalidResult("invalid-contract", "Generated UI contains an invalid element graph.");
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
    for (const childKey of element.children ?? []) {
      incomingReferenceCount.set(childKey, (incomingReferenceCount.get(childKey) ?? 0) + 1);
    }
  }

  const pendingElementKeys = [...incomingReferenceCount]
    .filter(([, referenceCount]) => referenceCount === 0)
    .map(([elementKey]) => elementKey);
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

    for (const childKey of spec.elements[elementKey]?.children ?? []) {
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
