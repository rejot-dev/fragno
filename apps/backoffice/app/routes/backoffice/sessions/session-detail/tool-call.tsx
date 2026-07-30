import type { DraftTool } from "@fragno-dev/pi-harness/workflow-session-projection";
import { useState, type ReactNode } from "react";

import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";

import {
  type PiToolCallArtifact,
  type ToolResultMessage,
  normalizePiContent,
} from "./assistant-runtime";
import { MessageImage, ScrollablePre } from "./message-content";
import {
  formatExecCodeModeExpandedResult,
  formatJson,
  formatToolArgumentsDisplayText,
  getCodeArgument,
  getLoadedSkillName,
  getReadPath,
} from "./tool-arguments";
import { formatEventTimestamp, tapScale } from "./ui";

export function ToolCallBlock(props: ToolCallMessagePartProps) {
  const [resultExpanded, setResultExpanded] = useState(false);
  const createdAt = useAuiState((state) => state.message.createdAt);
  const artifact = (props.artifact ?? null) as PiToolCallArtifact | null;
  const draftTool = artifact?.draftTool ?? null;
  const completedToolResult = artifact?.completedToolResult ?? null;
  const loadedSkillName = getLoadedSkillName({
    argumentsValue: props.args,
    completedToolResult,
    name: props.toolName,
  });

  const readPath =
    props.toolName === "read"
      ? (getReadPath(props.args) ?? getReadPath(completedToolResult?.details))
      : null;
  const canExpandResult = props.toolName === "execCodeMode" && completedToolResult !== null;
  const running =
    props.status.type === "running" || Boolean(draftTool && draftTool.status !== "done");
  const status = running
    ? toolStatusLabel(draftTool)
    : completedToolResult?.isError
      ? "Failed"
      : "Done";

  const displayLabel = loadedSkillName ? "Skill loaded" : props.toolName;
  const displayDetail = loadedSkillName ?? readPath ?? status;

  return (
    <details
      className={`group/tool overflow-hidden border bg-[var(--bo-panel)] ${loadedSkillName ? "border-[color:var(--bo-live)]" : completedToolResult?.isError ? "border-[color:var(--bo-failed)]" : "border-[color:var(--bo-border)]"}`}
    >
      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 marker:hidden">
        <span
          className={`inline-flex min-w-0 items-center gap-2 text-xs font-medium ${loadedSkillName ? "text-[var(--bo-live)]" : "text-[var(--bo-fg)]"}`}
        >
          <span
            className={`size-1.5 flex-none rounded-full ${running ? "animate-pulse bg-[var(--bo-accent)]" : completedToolResult?.isError ? "bg-[var(--bo-failed)]" : "bg-[var(--bo-live)]"}`}
          />
          <span className="truncate">{displayLabel}</span>
        </span>
        <code className="truncate font-mono text-[10px] text-[var(--bo-muted-2)]">
          {displayDetail}
        </code>
        <span className="grid min-h-10 w-[10.5rem] grid-cols-[7rem_3.5rem] items-center text-right text-[10px] text-[var(--bo-muted-2)] transition-colors duration-150 group-hover/tool:text-[var(--bo-fg)]">
          <time className="tabular-nums">{formatEventTimestamp(createdAt)}</time>
          <span className="font-medium tracking-[0.1em] uppercase">
            <span className="group-open/tool:hidden">View</span>
            <span className="hidden group-open/tool:inline">Close</span>
          </span>
        </span>
      </summary>
      <div className="space-y-3 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        <ToolArgumentsBlock value={props.args} />
        {draftTool?.partialResult !== undefined ? (
          <ToolResultSection label="Live result">
            <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
          </ToolResultSection>
        ) : null}
        {completedToolResult ? (
          <ToolResultSection
            label={completedToolResult.isError ? "Error" : "Result"}
            action={
              canExpandResult ? (
                <button
                  type="button"
                  onClick={() => {
                    setResultExpanded((current) => !current);
                  }}
                  className={`inline-flex min-h-10 items-center px-2 text-[10px] font-medium text-[var(--bo-muted)] transition-[color,scale] duration-150 ease-out hover:text-[var(--bo-fg)] ${tapScale}`}
                >
                  {resultExpanded ? "Collapse" : "Expand"}
                </button>
              ) : null
            }
          >
            <ToolResultContent
              expanded={canExpandResult && resultExpanded}
              result={completedToolResult}
              useExecCodeModeFormatting={canExpandResult}
            />
          </ToolResultSection>
        ) : null}
      </div>
    </details>
  );
}

function toolStatusLabel(draftTool: DraftTool | null) {
  if (!draftTool || draftTool.status === "running") {
    return "Running";
  }
  if (draftTool.status === "done") {
    return "Done";
  }
  return "Preparing";
}

function ToolResultSection({
  action,
  children,
  label,
}: {
  action?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}

function ToolArgumentsBlock({ value }: { value: unknown }) {
  const codeArgument = getCodeArgument(value);
  if (!codeArgument) {
    return <ScrollablePre>{formatToolArgumentsDisplayText({ value })}</ScrollablePre>;
  }

  const restKeys = Object.keys(codeArgument.rest);
  return (
    <div className="space-y-2">
      {restKeys.length > 0 ? <ScrollablePre>{formatJson(codeArgument.rest)}</ScrollablePre> : null}
      <ScrollablePre>{formatToolArgumentsDisplayText({ value })}</ScrollablePre>
    </div>
  );
}

function ToolResultContent({
  expanded,
  result,
  useExecCodeModeFormatting,
}: {
  expanded: boolean;
  result: ToolResultMessage;
  useExecCodeModeFormatting: boolean;
}) {
  const expandedText = useExecCodeModeFormatting ? formatExecCodeModeExpandedResult(result) : null;
  if (expanded && expandedText !== null) {
    return <ScrollablePre expanded>{expandedText}</ScrollablePre>;
  }

  return (
    <div className="space-y-2">
      {normalizePiContent(result.content).map((block, index) => {
        if (block.type === "text") {
          return <ScrollablePre key={`result-${index}`}>{block.text}</ScrollablePre>;
        }
        if (block.type === "image") {
          return (
            <MessageImage
              key={`result-${index}`}
              image={`data:${block.mimeType};base64,${block.data}`}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
