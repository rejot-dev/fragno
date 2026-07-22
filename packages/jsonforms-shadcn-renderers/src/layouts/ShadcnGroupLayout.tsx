import type { GroupLayout, LayoutProps, RankedTester } from "@jsonforms/core";
import { rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch } from "@jsonforms/react";

import { FieldSet, FieldLabel, FieldDescription } from "@/components/ui/field";

import { withJsonFormsLayoutProps } from "../jsonforms-hocs";
import { createUiSchemaElementKeys } from "../util/ui-schema-keys";

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

  const elements = groupLayout.elements ?? [];
  const elementKeys = createUiSchemaElementKeys(elements);

  return (
    <FieldSet>
      {label && <FieldLabel>{label}</FieldLabel>}
      {description && <FieldDescription>{description}</FieldDescription>}
      {elements.map((child, index) => (
        <JsonFormsDispatch
          key={`${path}-${elementKeys[index]}`}
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
