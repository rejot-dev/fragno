import { describe, expect, test } from "vitest";

import { backofficeUiComponentDefinitions } from "@fragno-private/backoffice-ui/catalog";

import { generateBackofficeUiCatalogDeclarations } from "./component-reference-generation";

describe("Backoffice UI builder declaration generation", () => {
  test("declares every canonical component with exact nested prop types and limits", () => {
    const declarations = generateBackofficeUiCatalogDeclarations();
    const componentNames = Object.keys(backofficeUiComponentDefinitions);

    expect(declarations).toContain("type BackofficeUiComponents = {");
    expect(declarations).not.toContain("object[]");
    expect(declarations).toContain("detail?: string;");
    expect(declarations).toContain("[key: string]: unknown;");
    expect(declarations).toMatch(/\/\*\* 1-200 characters \*\/\s+title: string;/u);
    expect(declarations).toMatch(/\/\*\* at most 64 items \*\/\s+rows: \{/u);

    expect(componentNames).toEqual([
      "Stack",
      "Grid",
      "Section",
      "Panel",
      "PanelTable",
      "PanelTableRow",
      "RowList",
      "ListRow",
      "Divider",
      "Heading",
      "Text",
      "Code",
      "Image",
      "Callout",
      "Metric",
      "Number",
      "Badge",
      "RunStatus",
      "Icon",
      "Link",
      "RelativeTime",
      "KeyValue",
      "List",
      "Table",
      "Progress",
      "SparkBars",
      "BarChart",
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
