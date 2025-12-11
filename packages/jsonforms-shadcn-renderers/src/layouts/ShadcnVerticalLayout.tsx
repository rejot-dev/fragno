import type { LayoutProps, RankedTester, VerticalLayout } from "@jsonforms/core";
import { rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch, withJsonFormsLayoutProps } from "@jsonforms/react";
import { Fragment } from "react";
import { FieldSeparator, FieldGroup } from "@/components/ui/field";

export const ShadcnVerticalLayout = ({
  uischema,
  schema,
  path,
  enabled,
  visible,
  renderers,
  cells,
}: LayoutProps) => {
  // Safe cast: tester ensures uischema type is "VerticalLayout"
  const verticalLayout = uischema as VerticalLayout;

  if (!visible || !verticalLayout.elements || verticalLayout.elements.length === 0) {
    return null;
  }

  return (
    <FieldGroup>
      {verticalLayout.elements.map((child, index) => {
        const isGroup = child.type === "Group";
        const prevElement = verticalLayout.elements[index - 1];
        const prevIsGroup = prevElement?.type === "Group";
        const showSeparator = index > 0 && (isGroup || prevIsGroup);

        return (
          <Fragment key={`${path}-${index}`}>
            {showSeparator && <FieldSeparator />}
            <div>
              <JsonFormsDispatch
                uischema={child}
                schema={schema}
                path={path}
                enabled={enabled}
                renderers={renderers}
                cells={cells}
              />
            </div>
          </Fragment>
        );
      })}
    </FieldGroup>
  );
};

export const shadcnVerticalLayoutTester: RankedTester = rankWith(1, uiTypeIs("VerticalLayout"));

export const ShadcnVerticalLayoutContext = withJsonFormsLayoutProps(ShadcnVerticalLayout);
