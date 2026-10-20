import { ProgressMeter } from "@fragno-private/design-system/progress-meter";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Progress: ComponentFn<typeof backofficeUiCatalog, "Progress"> = ({ props }) => (
  <ProgressMeter
    tone={props.tone}
    label={props.label}
    percent={props.value}
    detail={props.detail}
  />
);
