import { useState } from "react";

import { Switch } from "./switch";

export default { title: "Controls/Switch" };

export function ViewOptions() {
  const [toolCalls, setToolCalls] = useState(true);
  const [reasoning, setReasoning] = useState(true);
  const [usage, setUsage] = useState(false);

  return (
    <div className="bo-popover-surface w-64 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2">
      <Switch label="Tool calls" checked={toolCalls} onCheckedChange={setToolCalls} />
      <Switch label="Reasoning" checked={reasoning} onCheckedChange={setReasoning} />
      <Switch label="Usage" checked={usage} onCheckedChange={setUsage} />
    </div>
  );
}
