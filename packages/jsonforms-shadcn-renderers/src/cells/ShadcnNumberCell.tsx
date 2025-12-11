import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isNumberControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnNumberInput } from "../shadcn-controls/ShadcnNumberInput";

export const ShadcnNumberCell = (props: CellProps & WithClassname) => {
  return <ShadcnNumberInput {...props} />;
};

export const shadcnNumberCellTester: RankedTester = rankWith(2, isNumberControl);

export const ShadcnNumberCellContext = withJsonFormsCellProps(ShadcnNumberCell);
