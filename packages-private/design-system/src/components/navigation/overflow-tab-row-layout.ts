export type MeasuredOverflowTab = {
  width: number;
  startsGroup: boolean;
};

type OverflowTabRowMeasurement = {
  availableWidth: number;
  tabs: readonly MeasuredOverflowTab[];
  moreTriggerWidth: number;
  separatorWidth: number;
  gapWidth: number;
};

type MeasuredRow = {
  width: number;
  elementCount: number;
};

const appendMeasuredElement = (row: MeasuredRow, width: number, gapWidth: number): MeasuredRow => ({
  width: row.width + (row.elementCount > 0 ? gapWidth : 0) + width,
  elementCount: row.elementCount + 1,
});

const appendMeasuredTab = (
  row: MeasuredRow,
  tab: MeasuredOverflowTab,
  separatorWidth: number,
  gapWidth: number,
): MeasuredRow => {
  const rowWithSeparator =
    tab.startsGroup && row.elementCount > 0
      ? appendMeasuredElement(row, separatorWidth, gapWidth)
      : row;
  return appendMeasuredElement(rowWithSeparator, tab.width, gapWidth);
};

export const visibleOverflowTabCount = ({
  availableWidth,
  tabs,
  moreTriggerWidth,
  separatorWidth,
  gapWidth,
}: OverflowTabRowMeasurement): number => {
  let completeRow: MeasuredRow = { width: 0, elementCount: 0 };
  for (const tab of tabs) {
    completeRow = appendMeasuredTab(completeRow, tab, separatorWidth, gapWidth);
  }
  if (completeRow.width <= availableWidth) {
    return tabs.length;
  }

  let visibleRow: MeasuredRow = { width: 0, elementCount: 0 };
  let visibleCount = 0;
  for (const tab of tabs) {
    const candidateRow = appendMeasuredTab(visibleRow, tab, separatorWidth, gapWidth);
    const candidateWithMore = appendMeasuredElement(candidateRow, moreTriggerWidth, gapWidth);
    if (candidateWithMore.width > availableWidth) {
      break;
    }
    visibleRow = candidateRow;
    visibleCount += 1;
  }

  return visibleCount;
};
