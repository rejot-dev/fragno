import type { HorizontalLayout, LayoutProps, RankedTester } from "@jsonforms/core";
import { rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch, withJsonFormsLayoutProps } from "@jsonforms/react";

export const ShadcnHorizontalLayout = ({
  uischema,
  schema,
  path,
  enabled,
  visible,
  renderers,
  cells,
}: LayoutProps) => {
  const horizontalLayout = uischema as HorizontalLayout;

  if (!visible || !horizontalLayout.elements || horizontalLayout.elements.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-row gap-4">
      {horizontalLayout.elements.map((child, index) => (
        <div key={`${path}-${index}`} className="flex-1">
          <JsonFormsDispatch
            uischema={child}
            schema={schema}
            path={path}
            enabled={enabled}
            renderers={renderers}
            cells={cells}
          />
        </div>
      ))}
    </div>
  );
};

export const shadcnHorizontalLayoutTester: RankedTester = rankWith(1, uiTypeIs("HorizontalLayout"));

export const ShadcnHorizontalLayoutContext = withJsonFormsLayoutProps(ShadcnHorizontalLayout);
