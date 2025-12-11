import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isDateTimeControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnDateTimePicker } from "../shadcn-controls/ShadcnDateTimePicker";

export const ShadcnDateTimeCell = (props: CellProps & WithClassname) => {
  return <ShadcnDateTimePicker {...props} />;
};

export const shadcnDateTimeCellTester: RankedTester = rankWith(2, isDateTimeControl);

export const ShadcnDateTimeCellContext = withJsonFormsCellProps(ShadcnDateTimeCell);
