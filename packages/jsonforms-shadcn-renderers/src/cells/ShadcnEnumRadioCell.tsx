import type { EnumCellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { and, isEnumControl, optionIs, rankWith } from "@jsonforms/core";
import { withJsonFormsEnumCellProps } from "@jsonforms/react";
import { ShadcnRadioGroup } from "../shadcn-controls/ShadcnRadioGroup";

export const ShadcnEnumRadioCell = (props: EnumCellProps & WithClassname) => {
  return <ShadcnRadioGroup {...props} options={props.options ?? []} />;
};

export const shadcnEnumRadioCellTester: RankedTester = rankWith(
  20,
  and(isEnumControl, optionIs("format", "radio")),
);

export const ShadcnEnumRadioCellContext = withJsonFormsEnumCellProps(ShadcnEnumRadioCell);
