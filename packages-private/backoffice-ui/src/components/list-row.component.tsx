import { ListRow as ListRowView, ListRowIcon } from "@fragno-private/design-system/list-row";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";

export const ListRow: ComponentFn<typeof backofficeUiCatalog, "ListRow"> = ({
  props,
  children,
  slots,
}) => {
  const { links } = useBackofficeUiRenderContext();
  return (
    <ListRowView
      leading={props.icon ? <ListRowIcon name={props.icon} tone={props.tone ?? null} /> : null}
      title={props.title}
      detail={props.detail ?? null}
      trailing={children}
      to={props.to && links ? links(props.to) : null}
      expansion={
        slots?.expanded === undefined
          ? null
          : { label: props.expandLabel ?? "Details", content: slots.expanded }
      }
    />
  );
};
