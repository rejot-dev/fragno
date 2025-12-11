import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isIntegerControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnNumberInput } from "../shadcn-controls/ShadcnNumberInput";

export const ShadcnIntegerCell = (props: CellProps & WithClassname) => {
  return <ShadcnNumberInput {...props} step="1" />;
};

export const shadcnIntegerCellTester: RankedTester = rankWith(2, isIntegerControl);

export const ShadcnIntegerCellContext = withJsonFormsCellProps(ShadcnIntegerCell);
