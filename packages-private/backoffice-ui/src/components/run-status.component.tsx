import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { RunStatusLight } from "./run-status-light";

export const RunStatus: ComponentFn<typeof backofficeUiCatalog, "RunStatus"> = ({ props }) => (
  <RunStatusLight status={props.status} />
);
