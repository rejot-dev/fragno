import {
  OptionsPopover,
  OptionsPopoverDownload,
} from "@fragno-private/design-system/options-popover";
import { Switch } from "@fragno-private/design-system/switch";

export function SessionDisplayOptions({
  exportFilename,
  exportHref,
  showThinking,
  showToolCalls,
  showUsage,
  onShowThinkingChange,
  onShowToolCallsChange,
  onShowUsageChange,
}: {
  exportFilename: string;
  exportHref: string;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  onShowThinkingChange: (value: boolean) => void;
  onShowToolCallsChange: (value: boolean) => void;
  onShowUsageChange: (value: boolean) => void;
}) {
  return (
    <OptionsPopover label="View">
      <Switch label="Tool calls" checked={showToolCalls} onCheckedChange={onShowToolCallsChange} />
      <Switch label="Reasoning" checked={showThinking} onCheckedChange={onShowThinkingChange} />
      <Switch label="Usage" checked={showUsage} onCheckedChange={onShowUsageChange} />
      <OptionsPopoverDownload href={exportHref} filename={exportFilename}>
        Download JSONL
      </OptionsPopoverDownload>
    </OptionsPopover>
  );
}
