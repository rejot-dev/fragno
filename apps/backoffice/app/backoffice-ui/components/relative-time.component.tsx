import type { ComponentFn } from "@json-render/react";

import { formatRelativeTime } from "@/routes/backoffice/automations/formatting";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";

export const RelativeTime: ComponentFn<typeof backofficeUiCatalog, "RelativeTime"> = ({
  props,
}) => {
  const { now } = useBackofficeUiRenderContext();
  if (props.time === null) {
    return <span className="text-xs text-[var(--bo-muted-2)]">—</span>;
  }
  return (
    <time
      dateTime={props.time}
      title={props.time}
      className="text-xs whitespace-nowrap text-[var(--bo-muted-2)] tabular-nums"
    >
      {formatRelativeTime(props.time, now)}
    </time>
  );
};
