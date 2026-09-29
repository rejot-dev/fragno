import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

import { Icon } from "./icon";
import { UnderlineTab, UnderlineTabList, UnderlineToggleButton } from "./underline-tabs";

export default { title: "Navigation/Underline tabs" };

export function WithPanels() {
  return (
    <Tabs.Root defaultValue="graph" className="max-w-md">
      <UnderlineTabList aria-label="Workflow preview views">
        <UnderlineTab value="code">
          <Icon name="code" />
          Code
        </UnderlineTab>
        <UnderlineTab value="graph">
          <Icon name="share-2" />
          Graph
        </UnderlineTab>
        <UnderlineTab value="history" disabled>
          History
        </UnderlineTab>
      </UnderlineTabList>
      <Tabs.Panel value="code" className="pt-3 font-mono text-xs text-[var(--bo-fg)]">
        export default workflow();
      </Tabs.Panel>
      <Tabs.Panel value="graph" className="pt-3 text-sm text-[var(--bo-muted)]">
        Graph view
      </Tabs.Panel>
    </Tabs.Root>
  );
}

export function Toggles() {
  const [display, setDisplay] = useState("flow");
  return (
    <div role="group" aria-label="Workflow display" className="flex items-center gap-1">
      {["Flow", "Simple", "Code"].map((label) => (
        <UnderlineToggleButton
          key={label}
          pressed={display === label.toLowerCase()}
          onClick={() => {
            setDisplay(label.toLowerCase());
          }}
        >
          {label}
        </UnderlineToggleButton>
      ))}
    </div>
  );
}
