import type { CellProps, RankedTester } from "@jsonforms/core";
import { isRangeControl, rankWith } from "@jsonforms/core";
import { withJsonFormsCellProps } from "@jsonforms/react";
import { ShadcnSlider } from "../shadcn-controls/ShadcnSlider";

export const ShadcnSliderCell = (props: CellProps) => {
  const { visible } = props;

  if (!visible) {
    return null;
  }

  return <ShadcnSlider {...props} />;
};

export const shadcnSliderCellTester: RankedTester = rankWith(2, isRangeControl);

export const ShadcnSliderCellContext = withJsonFormsCellProps(ShadcnSliderCell);
