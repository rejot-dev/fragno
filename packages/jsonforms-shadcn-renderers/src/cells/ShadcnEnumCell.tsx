import type { EnumCellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isEnumControl, rankWith } from "@jsonforms/core";
import { withJsonFormsEnumCellProps } from "@jsonforms/react";
import { ShadcnSelect } from "../shadcn-controls/ShadcnSelect";

export const ShadcnEnumCell = (props: EnumCellProps & WithClassname) => {
  return <ShadcnSelect {...props} options={props.options ?? []} />;
};

export const shadcnEnumCellTester: RankedTester = rankWith(2, isEnumControl);

export const ShadcnEnumCellContext = withJsonFormsEnumCellProps(ShadcnEnumCell);
