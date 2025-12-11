import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { and, isBooleanControl, optionIs, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnSwitch } from "../shadcn-controls/ShadcnSwitch";

export const ShadcnBooleanToggleCell = (props: CellProps & WithClassname) => {
  return <ShadcnSwitch {...props} />;
};

export const shadcnBooleanToggleCellTester: RankedTester = rankWith(
  3,
  and(isBooleanControl, optionIs("toggle", true)),
);

export const ShadcnBooleanToggleCellContext = withJsonFormsCellProps(ShadcnBooleanToggleCell);
