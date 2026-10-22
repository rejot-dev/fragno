import { KeyValueList } from "@fragno-private/design-system/key-value-list";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const KeyValue: ComponentFn<typeof backofficeUiCatalog, "KeyValue"> = ({ props }) => (
  <KeyValueList
    columns={props.columns}
    items={props.items.slice(0, BACKOFFICE_UI_DATA_LIMITS.keyValueItems)}
  />
);
