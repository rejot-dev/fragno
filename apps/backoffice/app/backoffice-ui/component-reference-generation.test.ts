import { describe, expect, test } from "vitest";

import { backofficeUiComponentDefinitions } from "./catalog";
import { generateBackofficeUiBuilderDeclarations } from "./component-reference-generation";

describe("Backoffice UI builder declaration generation", () => {
  test("declares every canonical component with exact nested prop types and limits", () => {
    const declarations = generateBackofficeUiBuilderDeclarations();
    const componentNames = Object.keys(backofficeUiComponentDefinitions);

    expect(declarations).toContain("declare const ui: {");
    expect(declarations).not.toContain("object[]");
    expect(declarations).toContain("detail?: string;");
    expect(declarations).toContain("[key: string]: string;");
    expect(declarations).toMatch(/\/\*\* 1-200 characters \*\/\s+title: string;/u);
    expect(declarations).toMatch(
      /\/\*\* at most 64 items; each item's values at most 2000 characters \*\/\s+rows: \{/u,
    );

    expect(componentNames).toEqual([
      "Stack",
      "Grid",
      "Section",
      "Divider",
      "Heading",
      "Text",
      "Code",
      "Image",
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
      const componentIndex = declarations.indexOf(`/** Builds ${componentName}. `);
      expect(componentIndex).toBeGreaterThan(previousIndex);
      previousIndex = componentIndex;
    }
  });
});
