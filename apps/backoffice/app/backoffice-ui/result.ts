import { z } from "zod";

import { validateSpec, VisibilityConditionSchema, type Spec } from "@json-render/core";

import {
  backofficeUiCatalog,
  backofficeUiComponentDefinitions,
  type BackofficeUiSpec,
} from "./catalog";
import { validateGeneratedProps } from "./generated-props";

export type BackofficeUiResultV1 = Record<string, unknown> & {
  $ui: {
    version: 1;
    state: Record<string, unknown>;
    spec: BackofficeUiSpec;
  };
};

const backofficeUiResultEnvelopeSchema = z.looseObject({
  $ui: z.strictObject({
    version: z.literal(1),
    state: z.record(z.string(), z.unknown()),
    spec: z.unknown(),
  }),
});

export function parseBackofficeUiResult(value: unknown): BackofficeUiResultV1 | null {
  const envelopeResult = backofficeUiResultEnvelopeSchema.safeParse(value);
  if (!envelopeResult.success) {
    return null;
  }

  const specResult = backofficeUiCatalog.validate(envelopeResult.data.$ui.spec);
  if (!specResult.success || !specResult.data) {
    return null;
  }

  const spec = specResult.data as Spec;
  if (!validateSpec(spec).valid || hasCyclicChildReferences(spec)) {
    return null;
  }

  for (const element of Object.values(spec.elements)) {
    if (!(element.type in backofficeUiComponentDefinitions)) {
      return null;
    }

    const componentName = element.type as keyof typeof backofficeUiComponentDefinitions;
    const componentDefinition = backofficeUiComponentDefinitions[componentName];
    if (
      !validateGeneratedProps(componentDefinition.props, element.props) ||
      (element.visible !== undefined &&
        !VisibilityConditionSchema.safeParse(element.visible).success)
    ) {
      return null;
    }
  }

  return {
    ...envelopeResult.data,
    $ui: {
      version: 1,
      state: envelopeResult.data.$ui.state,
      spec,
    },
  };
}

function hasCyclicChildReferences(spec: Spec) {
  const incomingReferenceCount = new Map(
    Object.keys(spec.elements).map((elementKey) => [elementKey, 0]),
  );

  for (const element of Object.values(spec.elements)) {
    for (const childKey of element.children ?? []) {
      const currentCount = incomingReferenceCount.get(childKey);
      if (currentCount !== undefined) {
        incomingReferenceCount.set(childKey, currentCount + 1);
      }
    }
  }

  const pendingElementKeys = [...incomingReferenceCount]
    .filter(([, referenceCount]) => referenceCount === 0)
    .map(([elementKey]) => elementKey);
  let processedElementCount = 0;

  while (pendingElementKeys.length > 0) {
    const elementKey = pendingElementKeys.pop();
    if (!elementKey) {
      continue;
    }

    processedElementCount += 1;
    for (const childKey of spec.elements[elementKey]?.children ?? []) {
      const nextCount = (incomingReferenceCount.get(childKey) ?? 0) - 1;
      incomingReferenceCount.set(childKey, nextCount);
      if (nextCount === 0) {
        pendingElementKeys.push(childKey);
      }
    }
  }

  return processedElementCount !== incomingReferenceCount.size;
}
