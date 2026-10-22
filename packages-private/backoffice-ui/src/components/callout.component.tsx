import { Callout as CalloutView } from "@fragno-private/design-system/callout";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Callout: ComponentFn<typeof backofficeUiCatalog, "Callout"> = ({ props }) => (
  <CalloutView tone={props.tone} title={props.title}>
    {props.text}
  </CalloutView>
);
