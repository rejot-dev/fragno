import { JSONUIProvider, Renderer } from "@json-render/react";

import { backofficeUiRegistry } from "./registry";
import type { BackofficeUiResultV1 } from "./result";

export function BackofficeUiRenderer({ ui }: { ui: BackofficeUiResultV1["$ui"] }) {
  return (
    <div className="min-w-0 border-l-2 border-[color:var(--bo-accent)] pl-3">
      <JSONUIProvider registry={backofficeUiRegistry} initialState={ui.state}>
        <Renderer spec={ui.spec} registry={backofficeUiRegistry} />
      </JSONUIProvider>
    </div>
  );
}
