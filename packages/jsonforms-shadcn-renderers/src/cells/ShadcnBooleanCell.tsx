import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isBooleanControl, rankWith } from "@jsonforms/core";

import { withJsonFormsCellProps } from "../jsonforms-hocs";
import { ShadcnCheckbox } from "../shadcn-controls/ShadcnCheckbox";

export const ShadcnBooleanCell = (props: CellProps & WithClassname) => {
  return <ShadcnCheckbox {...props} />;
};

export const shadcnBooleanCellTester: RankedTester = rankWith(2, isBooleanControl);

export const ShadcnBooleanCellContext = withJsonFormsCellProps(ShadcnBooleanCell);
