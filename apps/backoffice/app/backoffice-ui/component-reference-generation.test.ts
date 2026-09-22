import { describe, expect, test } from "vitest";

import { backofficeUiComponentDefinitions } from "./catalog";
import { generateBackofficeUiCatalogReferenceMarkdown } from "./component-reference-generation";

describe("Backoffice UI component reference generation", () => {
  test("renders exact nested prop types for every canonical component", () => {
    const reference = generateBackofficeUiCatalogReferenceMarkdown();
    const componentNames = Object.keys(backofficeUiComponentDefinitions);

    expect(reference).toContain("# Production Component Catalog");
    expect(reference).not.toContain("object[]");
    expect(reference).toContain("detail?: string;");
    expect(reference).toContain("[key: string]: string;");
    expect(reference).toContain("- items[].title: 1-200 characters");

    expect(componentNames).toEqual([
      "Stack",
      "Grid",
      "Section",
      "Divider",
      "Heading",
      "Text",
      "Code",
      "Callout",
      "Metric",
      "Badge",
      "KeyValue",
      "List",
      "Table",
      "Progress",
      "TextInput",
      "TextArea",
      "Select",
      "Checkbox",
      "FileUpload",
      "WorkflowEventButton",
    ]);

    let previousIndex = -1;
    for (const componentName of componentNames) {
      const componentIndex = reference.indexOf(`### \`${componentName}\``);
      expect(componentIndex).toBeGreaterThan(previousIndex);
      previousIndex = componentIndex;
    }
  });
});
