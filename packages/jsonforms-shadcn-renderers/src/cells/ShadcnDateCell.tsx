import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isDateControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnDatePicker } from "../shadcn-controls/ShadcnDatePicker";

export const ShadcnDateCell = (props: CellProps & WithClassname) => {
  return <ShadcnDatePicker {...props} />;
};

export const shadcnDateCellTester: RankedTester = rankWith(2, isDateControl);

export const ShadcnDateCellContext = withJsonFormsCellProps(ShadcnDateCell);
