import { RecordList } from "@fragno-private/design-system/record-list";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const List: ComponentFn<typeof backofficeUiCatalog, "List"> = ({ props }) => (
  <RecordList
    items={props.items
      .slice(0, BACKOFFICE_UI_DATA_LIMITS.listItems)
      .map((item) => ({ ...item, tone: item.tone ?? "muted" }))}
    totalCount={props.items.length}
  />
);
