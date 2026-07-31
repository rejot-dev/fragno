import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type ProgressiveOverflowControlGroup<GroupId extends string> = {
  id: GroupId;
  content: ReactNode;
  collapsePriority: number;
};

export function ProgressiveOverflowControls<GroupId extends string>({
  groups,
  measurementBoundary,
  reservedWidth = 0,
  renderOverflow,
}: {
  groups: readonly ProgressiveOverflowControlGroup<GroupId>[];
  measurementBoundary?: HTMLElement | null;
  reservedWidth?: number;
  renderOverflow: (hiddenGroupIds: ReadonlySet<GroupId>) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupElementsRef = useRef(new Map<GroupId, HTMLDivElement>());
  const measuredGroupWidthsRef = useRef(new Map<GroupId, number>());
  const overflowElementRef = useRef<HTMLDivElement>(null);
  const measuredOverflowWidthRef = useRef(0);
  const [hiddenGroupIds, setHiddenGroupIds] = useState<ReadonlySet<GroupId>>(() => new Set());

  const measure = useCallback(() => {
    const container = containerRef.current;
    const overflowElement = overflowElementRef.current;
    if (!container || !overflowElement) {
      return;
    }

    for (const group of groups) {
      const element = groupElementsRef.current.get(group.id);
      const width = element?.getBoundingClientRect().width ?? 0;
      if (width > 0) {
        measuredGroupWidthsRef.current.set(group.id, width);
      }
    }

    const overflowWidth = overflowElement.getBoundingClientRect().width;
    if (overflowWidth > 0) {
      measuredOverflowWidthRef.current = overflowWidth;
    }

    const boundaryWidth = measurementBoundary?.getBoundingClientRect().width;
    const availableWidth =
      boundaryWidth && boundaryWidth > 0
        ? Math.max(0, boundaryWidth - reservedWidth)
        : container.getBoundingClientRect().width;
    const measuredGroupWidths = groups.map(({ id }) => measuredGroupWidthsRef.current.get(id) ?? 0);
    const measuredOverflowWidth = measuredOverflowWidthRef.current;
    if (
      availableWidth <= 0 ||
      measuredOverflowWidth <= 0 ||
      measuredGroupWidths.some((width) => width <= 0)
    ) {
      return;
    }

    const columnGap = Number.parseFloat(window.getComputedStyle(container).columnGap) || 0;
    let visibleGroupsWidth = measuredGroupWidths.reduce((total, width) => total + width, 0);
    const allGroupsWidth = visibleGroupsWidth + columnGap * Math.max(0, groups.length - 1);
    const nextHiddenGroupIds = new Set<GroupId>();
    if (allGroupsWidth > availableWidth) {
      const groupsByCollapsePriority = [...groups].sort(
        (left, right) => left.collapsePriority - right.collapsePriority,
      );
      let visibleGroupCount = groups.length;
      for (const group of groupsByCollapsePriority) {
        nextHiddenGroupIds.add(group.id);
        visibleGroupsWidth -= measuredGroupWidthsRef.current.get(group.id) ?? 0;
        visibleGroupCount -= 1;
        const requiredWidth =
          visibleGroupsWidth + measuredOverflowWidth + columnGap * visibleGroupCount;
        if (requiredWidth <= availableWidth) {
          break;
        }
      }
    }
    setHiddenGroupIds((current) =>
      setsEqual(current, nextHiddenGroupIds) ? current : nextHiddenGroupIds,
    );
  }, [groups, measurementBoundary, reservedWidth]);

  useLayoutEffect(() => {
    measure();

    const container = containerRef.current;
    if (typeof ResizeObserver === "undefined" || !container) {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    if (measurementBoundary) {
      resizeObserver.observe(measurementBoundary);
    }
    for (const element of groupElementsRef.current.values()) {
      resizeObserver.observe(element);
    }
    if (overflowElementRef.current) {
      resizeObserver.observe(overflowElementRef.current);
    }
    return () => {
      resizeObserver.disconnect();
    };
  }, [measure, measurementBoundary]);

  const hasOverflow = hiddenGroupIds.size > 0;
  const overflowMeasurementStyle = hasOverflow
    ? undefined
    : ({
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
      } satisfies CSSProperties);

  return (
    <div
      ref={containerRef}
      data-progressive-overflow-controls
      className="relative flex min-w-0 shrink items-center justify-end gap-2 overflow-hidden"
    >
      {groups.map((group) => (
        <div
          key={group.id}
          ref={(element) => {
            if (element) {
              groupElementsRef.current.set(group.id, element);
            } else {
              groupElementsRef.current.delete(group.id);
            }
          }}
          data-progressive-overflow-group={group.id}
          style={{ display: hiddenGroupIds.has(group.id) ? "none" : undefined }}
          className="shrink-0"
        >
          {group.content}
        </div>
      ))}

      <div
        ref={overflowElementRef}
        data-progressive-overflow-trigger
        aria-hidden={hasOverflow ? undefined : true}
        style={overflowMeasurementStyle}
        className="shrink-0"
      >
        {renderOverflow(hiddenGroupIds)}
      </div>
    </div>
  );
}

function setsEqual<Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
