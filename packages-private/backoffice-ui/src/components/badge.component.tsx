import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Badge: ComponentFn<typeof backofficeUiCatalog, "Badge"> = ({ props }) => (
  <BackofficeStatusLight tone={props.tone} dot={false} wrap role="status">
    {props.label}
  </BackofficeStatusLight>
);
