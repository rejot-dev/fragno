import type { EnumCellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isOneOfEnumControl, rankWith } from "@jsonforms/core";
import { withJsonFormsOneOfEnumCellProps } from "@jsonforms/react";
import { ShadcnSelect } from "../shadcn-controls/ShadcnSelect";

export const ShadcnOneOfEnumCell = (props: EnumCellProps & WithClassname) => {
  return <ShadcnSelect {...props} options={props.options ?? []} />;
};

export const shadcnOneOfEnumCellTester: RankedTester = rankWith(2, isOneOfEnumControl);

export const ShadcnOneOfEnumCellContext = withJsonFormsOneOfEnumCellProps(ShadcnOneOfEnumCell);
