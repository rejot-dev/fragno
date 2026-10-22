import { RowList as RowListView } from "@fragno-private/design-system/list-row";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const RowList: ComponentFn<typeof backofficeUiCatalog, "RowList"> = ({
  props,
  children,
}) => <RowListView empty={props.empty ?? null}>{children}</RowListView>;
