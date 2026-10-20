import { TonedPanel } from "@fragno-private/design-system/toned-panel";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Section: ComponentFn<typeof backofficeUiCatalog, "Section"> = ({
  props,
  children,
}) => (
  <TonedPanel tone={props.tone ?? "muted"} label={props.label}>
    {children}
  </TonedPanel>
);
