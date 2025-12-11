import type { GroupLayout, LayoutProps, RankedTester } from "@jsonforms/core";
import { rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch, withJsonFormsLayoutProps } from "@jsonforms/react";
import { FieldSet, FieldLabel, FieldDescription } from "@/components/ui/field";

export const ShadcnGroupLayout = ({
  uischema,
  schema,
  path,
  enabled,
  visible,
  renderers,
  cells,
  label,
}: LayoutProps) => {
  const groupLayout = uischema as GroupLayout;
  const description = groupLayout.options?.["description"] as string | undefined;

  if (!visible) {
    return null;
  }

  const hasElements = groupLayout.elements && groupLayout.elements.length > 0;

  return (
    <FieldSet>
      {label && <FieldLabel>{label}</FieldLabel>}
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasElements &&
        groupLayout.elements.map((child, index) => (
          <JsonFormsDispatch
            key={`${path}-${index}`}
            uischema={child}
            schema={schema}
            path={path}
            enabled={enabled}
            renderers={renderers}
            cells={cells}
          />
        ))}
    </FieldSet>
  );
};

export const shadcnGroupLayoutTester: RankedTester = rankWith(1, uiTypeIs("Group"));

export const ShadcnGroupLayoutContext = withJsonFormsLayoutProps(ShadcnGroupLayout);
