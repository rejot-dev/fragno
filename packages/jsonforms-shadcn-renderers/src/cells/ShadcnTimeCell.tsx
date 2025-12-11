import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isTimeControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnTimePicker } from "../shadcn-controls/ShadcnTimePicker";

export const ShadcnTimeCell = (props: CellProps & WithClassname) => {
  return <ShadcnTimePicker {...props} />;
};

export const shadcnTimeCellTester: RankedTester = rankWith(2, isTimeControl);

export const ShadcnTimeCellContext = withJsonFormsCellProps(ShadcnTimeCell);
