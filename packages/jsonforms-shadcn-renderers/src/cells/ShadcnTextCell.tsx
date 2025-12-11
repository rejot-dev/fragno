import type { CellProps, RankedTester, WithClassname } from "@jsonforms/core";
import { isStringControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnInput } from "../shadcn-controls/ShadcnInput";

export const ShadcnTextCell = (props: CellProps & WithClassname) => {
  return <ShadcnInput {...props} />;
};

export const shadcnTextCellTester: RankedTester = rankWith(1, isStringControl);

export const ShadcnTextCellContext = withJsonFormsCellProps(ShadcnTextCell);
