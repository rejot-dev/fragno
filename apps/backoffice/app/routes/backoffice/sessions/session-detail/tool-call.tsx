import type { DraftTool } from "@fragno-dev/pi-harness/workflow-session-projection";
import { useState } from "react";

import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";

import { parseBackofficeUiResult, type BackofficeUiParseResult } from "@/backoffice-ui/result";

import { type PiToolCallArtifact } from "./assistant-runtime";
import { getExecCodeModeResultDetails } from "./exec-code-mode";
import { ScrollablePre } from "./message-content";
import { formatJson, getLoadedSkillName, getReadPath } from "./tool-arguments";
import { ToolCallDetails, ToolResultSection } from "./tool-call-layout";
import { ToolResultContent } from "./tool-result-content";
import { ToolArgumentsBlock, ToolResultDisclosure } from "./tool-result-details";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import { formatEventTimestamp, tapScale } from "./ui";
import { useSessionWorkspaceNavigation } from "./workspace-context";
import { generatedUiWorkspaceId, workflowGraphWorkspaceId } from "./workspace-model";

const ordinaryResultPresentation: BackofficeUiParseResult = { kind: "ordinary" };

export function ToolCallBlock(props: ToolCallMessagePartProps) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const workspaceNavigation = useSessionWorkspaceNavigation();
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
  const execCodeModeDetails =
    props.toolName === "execCodeMode"
      ? getExecCodeModeResultDetails(completedToolResult?.details)
      : null;
  const resultPresentation = execCodeModeDetails?.hasResult
    ? parseBackofficeUiResult(execCodeModeDetails.result)
    : ordinaryResultPresentation;
  const hasTaggedGeneratedUi = resultPresentation.kind !== "ordinary";
  const canExpandOrdinaryResult =
    (execCodeModeDetails?.hasResult ?? false) && resultPresentation.kind === "ordinary";
  const generatedUiItemId = generatedUiWorkspaceId(props.toolCallId);
  const workflowGraphItemId = workflowGraphWorkspaceId(props.toolCallId);
  const canShowGeneratedUi =
    resultPresentation.kind === "valid" && Boolean(workspaceNavigation?.hasItem(generatedUiItemId));
  const canShowWorkflowGraph = Boolean(workspaceNavigation?.hasItem(workflowGraphItemId));
  const workspaceOptions: ToolWorkspaceSelectorOption[] = [
    ...(canShowWorkflowGraph
      ? [{ id: workflowGraphItemId, kind: "workflow-graph" as const, label: "Workflow graph" }]
      : []),
    ...(canShowGeneratedUi
      ? [{ id: generatedUiItemId, kind: "generated-ui" as const, label: "Interface" }]
      : []),
  ];
  const [resultExpanded, setResultExpanded] = useState(false);
  const running =
    props.status.type === "running" || Boolean(draftTool && draftTool.status !== "done");
  const status = running
    ? toolStatusLabel(draftTool)
    : completedToolResult?.isError
      ? "Failed"
      : "Done";

  const displayLabel = loadedSkillName ? "Skill loaded" : props.toolName;
  const displayDetail = loadedSkillName ?? readPath ?? status;

  const completedResultSection = completedToolResult ? (
    <ToolResultSection
      label={completedToolResult.isError ? "Error" : "Result"}
      action={
        canExpandOrdinaryResult ? (
          <button
            type="button"
            onClick={() => {
              setResultExpanded((current) => !current);
            }}
            className={`inline-flex min-h-10 items-center px-2 text-[10px] font-medium text-[var(--bo-muted)] transition-[color,scale] duration-150 ease-out hover:text-[var(--bo-fg)] ${tapScale}`}
          >
            {resultExpanded ? "Hide raw" : "Show raw"}
          </button>
        ) : null
      }
    >
      <ToolResultContent
        expanded={canExpandOrdinaryResult && resultExpanded}
        hasRawResult={execCodeModeDetails?.hasResult ?? false}
        parsedResult={resultPresentation}
        rawResult={execCodeModeDetails?.result}
        result={completedToolResult}
        useExecCodeModeFormatting={execCodeModeDetails !== null}
      />
    </ToolResultSection>
  ) : null;

  const partialResult =
    draftTool?.partialResult !== undefined ? (
      <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
    ) : null;
  const logs =
    execCodeModeDetails && execCodeModeDetails.logs.length > 0 ? (
      <ScrollablePre>{execCodeModeDetails.logs.join("\n")}</ScrollablePre>
    ) : null;

  return (
    <div className="flex items-start gap-2">
      <ToolCallDetails
        autoOpen={hasTaggedGeneratedUi}
        resetKey={props.toolCallId}
        className={`group/tool min-w-0 flex-1 overflow-hidden border bg-[var(--bo-panel)] ${loadedSkillName ? "border-[color:var(--bo-live)]" : completedToolResult?.isError ? "border-[color:var(--bo-failed)]" : "border-[color:var(--bo-border)]"}`}
      >
        <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 marker:hidden sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
          <span
            className={`inline-flex min-w-0 items-center gap-2 text-xs font-medium ${loadedSkillName ? "text-[var(--bo-live)]" : "text-[var(--bo-fg)]"}`}
          >
            <span
              className={`size-1.5 flex-none rounded-full ${running ? "animate-pulse bg-[var(--bo-accent)]" : completedToolResult?.isError ? "bg-[var(--bo-failed)]" : "bg-[var(--bo-live)]"}`}
            />
            <span className="truncate">{displayLabel}</span>
          </span>
          <code className="hidden truncate font-mono text-[10px] text-[var(--bo-muted-2)] sm:block">
            {displayDetail}
          </code>
          <span className="grid min-h-10 grid-cols-1 items-center text-right text-[10px] text-[var(--bo-muted-2)] transition-colors duration-150 group-hover/tool:text-[var(--bo-fg)] sm:w-[10.5rem] sm:grid-cols-[7rem_3.5rem]">
            <time className="hidden tabular-nums sm:block">{formatEventTimestamp(createdAt)}</time>
            <span className="font-medium tracking-[0.1em] uppercase">
              <span className="group-open/tool:hidden">View</span>
              <span className="hidden group-open/tool:inline">Close</span>
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
          {hasTaggedGeneratedUi && completedToolResult ? (
            <>
              {completedResultSection}
              <ToolResultDisclosure label="Code">
                <ToolArgumentsBlock rawText={props.argsText} value={props.args} />
              </ToolResultDisclosure>
              {partialResult ? (
                <ToolResultDisclosure label="Live result">{partialResult}</ToolResultDisclosure>
              ) : null}
              {logs ? <ToolResultDisclosure label="Logs">{logs}</ToolResultDisclosure> : null}
            </>
          ) : (
            <>
              <ToolArgumentsBlock rawText={props.argsText} value={props.args} />
              {partialResult ? (
                <ToolResultSection label="Live result">{partialResult}</ToolResultSection>
              ) : null}
              {logs ? <ToolResultSection label="Logs">{logs}</ToolResultSection> : null}
              {completedResultSection}
            </>
          )}
        </div>
      </ToolCallDetails>
      <ToolWorkspaceSelector options={workspaceOptions} toolLabel={displayLabel} />
    </div>
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
