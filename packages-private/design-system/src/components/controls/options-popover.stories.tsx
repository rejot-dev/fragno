import { useState } from "react";

import { OptionsPopover, OptionsPopoverDownload } from "./options-popover";
import { Switch } from "./switch";

export default { title: "Controls/Options popover" };

export function ViewOptions() {
  const [toolCalls, setToolCalls] = useState(true);
  const [reasoning, setReasoning] = useState(true);
  const [usage, setUsage] = useState(false);

  return (
    <div className="flex justify-end">
      <OptionsPopover label="View">
        <Switch label="Tool calls" checked={toolCalls} onCheckedChange={setToolCalls} />
        <Switch label="Reasoning" checked={reasoning} onCheckedChange={setReasoning} />
        <Switch label="Usage" checked={usage} onCheckedChange={setUsage} />
        <OptionsPopoverDownload href="data:application/jsonl," filename="conversation.jsonl">
          Download JSONL
        </OptionsPopoverDownload>
      </OptionsPopover>
    </div>
  );
}
