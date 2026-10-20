import { useState } from "react";

import { PanelToggleButton } from "./panel-toggle-button";

export default { title: "Controls/Panel toggle button" };

export function Views() {
  const [shown, setShown] = useState<"workflow" | "interface" | null>("workflow");
  return (
    <div role="group" aria-label="Side panel views" className="flex items-center gap-1">
      <PanelToggleButton
        icon="share-2"
        label="Workflow graph"
        pressed={shown === "workflow"}
        onClick={() => {
          setShown((current) => (current === "workflow" ? null : "workflow"));
        }}
      />
      <PanelToggleButton
        icon="layout"
        label="Interface"
        pressed={shown === "interface"}
        onClick={() => {
          setShown((current) => (current === "interface" ? null : "interface"));
        }}
      />
    </div>
  );
}
