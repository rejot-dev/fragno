import type { UISchemaElement } from "@jsonforms/core";

export function createUiSchemaElementKeys(elements: readonly UISchemaElement[]): string[] {
  const occurrences = new Map<string, number>();

  return elements.map((element) => {
    const identity = JSON.stringify(element);
    if (identity === undefined) {
      throw new TypeError("UI schema elements must be JSON-serializable");
    }

    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}#${occurrence}`;
  });
}
