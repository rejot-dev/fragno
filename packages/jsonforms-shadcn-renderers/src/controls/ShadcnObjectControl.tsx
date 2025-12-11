import { useMemo } from "react";
import {
  findUISchema,
  Generate,
  isObjectControl,
  rankWith,
  type RankedTester,
  type StatePropsOfControlWithDetail,
} from "@jsonforms/core";
import { JsonFormsDispatch, withJsonFormsDetailProps } from "@jsonforms/react";

export const ShadcnObjectControl = ({
  renderers,
  cells,
  uischemas,
  schema,
  label,
  path,
  visible,
  enabled,
  uischema,
  rootSchema,
}: StatePropsOfControlWithDetail) => {
  const detailUiSchema = useMemo(
    () =>
      findUISchema(
        uischemas ?? [],
        schema,
        uischema.scope,
        path,
        () =>
          !path
            ? Generate.uiSchema(schema, "VerticalLayout", undefined, rootSchema)
            : {
                ...Generate.uiSchema(schema, "Group", undefined, rootSchema),
                label,
              },
        uischema,
        rootSchema,
      ),
    [uischemas, schema, uischema.scope, path, label, uischema, rootSchema],
  );

  if (!visible) {
    return null;
  }

  return (
    <JsonFormsDispatch
      visible={visible}
      enabled={enabled}
      schema={schema}
      uischema={detailUiSchema}
      path={path}
      renderers={renderers}
      cells={cells}
    />
  );
};

export const shadcnObjectControlTester: RankedTester = rankWith(2, isObjectControl);

export const ShadcnObjectControlContext = withJsonFormsDetailProps(ShadcnObjectControl);
