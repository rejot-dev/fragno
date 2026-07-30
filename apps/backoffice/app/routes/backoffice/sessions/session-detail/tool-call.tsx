import type { DraftTool } from "@fragno-dev/pi-harness/workflow-session-projection";
import { useEffect, useState, type ReactNode } from "react";

import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";

import { parseBackofficeUiResult, type BackofficeUiParseResult } from "@/backoffice-ui/result";

import {
  type PiToolCallArtifact,
  type ToolResultMessage,
  normalizePiContent,
} from "./assistant-runtime";
import { getExecCodeModeResultDetails } from "./exec-code-mode";
import { MessageImage, ScrollablePre } from "./message-content";
import { RawValueDisclosure, ResultContent } from "./result-content";
import {
  formatJson,
  formatResultValue,
  formatToolArgumentsDisplayText,
  getCodeArgument,
  getLoadedSkillName,
  getReadPath,
} from "./tool-arguments";
import { formatEventTimestamp, tapScale } from "./ui";
import { useSessionWorkspaceNavigation } from "./workspace-context";
import { generatedUiTabId, workflowGraphTabId } from "./workspace-model";

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
  const generatedUiWorkspaceTabId = generatedUiTabId(props.toolCallId);
  const workflowGraphWorkspaceTabId = workflowGraphTabId(props.toolCallId);
  const canOpenGeneratedUi =
    resultPresentation.kind === "valid" &&
    Boolean(workspaceNavigation?.hasTab(generatedUiWorkspaceTabId));
  const canOpenWorkflowGraph = Boolean(workspaceNavigation?.hasTab(workflowGraphWorkspaceTabId));
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
        onOpenGeneratedUi={
          canOpenGeneratedUi
            ? () => {
                workspaceNavigation?.openTab(generatedUiWorkspaceTabId);
              }
            : undefined
        }
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
    <ToolCallDetails
      autoOpen={hasTaggedGeneratedUi}
      resetKey={props.toolCallId}
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
        {canOpenWorkflowGraph ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                workspaceNavigation?.openTab(workflowGraphWorkspaceTabId);
              }}
              className={`inline-flex min-h-10 items-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-[10px] font-semibold tracking-[0.1em] text-[var(--bo-fg)] uppercase transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent)] ${tapScale}`}
            >
              Open workflow graph
            </button>
          </div>
        ) : null}
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
  );
}

export function ToolCallDetails({
  autoOpen,
  children,
  className,
  resetKey,
}: {
  autoOpen: boolean;
  children?: ReactNode;
  className: string;
  resetKey: string;
}) {
  const [open, setOpen] = useState(autoOpen);

  useEffect(() => {
    setOpen(autoOpen);
  }, [autoOpen, resetKey]);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className={className}
    >
      {children}
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

function ToolResultDisclosure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <details className="group/disclosure border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </span>
        <span className="text-[10px] font-medium tracking-[0.1em] text-[var(--bo-muted-2)] uppercase">
          <span className="group-open/disclosure:hidden">View</span>
          <span className="hidden group-open/disclosure:inline">Hide</span>
        </span>
      </summary>
      <div className="border-t border-[color:var(--bo-border)] p-2">{children}</div>
    </details>
  );
}

function ToolArgumentsBlock({ rawText, value }: { rawText?: string; value: unknown }) {
  const codeArgument = getCodeArgument(value);
  if (!codeArgument) {
    return <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>;
  }

  const restKeys = Object.keys(codeArgument.rest);
  return (
    <div className="space-y-2">
      {restKeys.length > 0 ? <ScrollablePre>{formatJson(codeArgument.rest)}</ScrollablePre> : null}
      <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>
    </div>
  );
}

export function ToolResultContent({
  expanded,
  hasRawResult,
  parsedResult,
  rawResult,
  result,
  useExecCodeModeFormatting,
  onOpenGeneratedUi,
}: {
  expanded: boolean;
  hasRawResult: boolean;
  parsedResult: BackofficeUiParseResult;
  rawResult: unknown;
  result: ToolResultMessage;
  useExecCodeModeFormatting: boolean;
  onOpenGeneratedUi?: () => void;
}) {
  const messageContent = (
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

  if (!useExecCodeModeFormatting || !hasRawResult) {
    return messageContent;
  }

  if (parsedResult.kind === "valid") {
    return <GeneratedUiWorkspaceSummary rawValue={rawResult} onOpen={onOpenGeneratedUi} />;
  }

  return (
    <ResultContent parsedValue={parsedResult} showRawValue={expanded} value={rawResult}>
      <ScrollablePre>{formatResultValue(rawResult)}</ScrollablePre>
    </ResultContent>
  );
}

function GeneratedUiWorkspaceSummary({
  rawValue,
  onOpen,
}: {
  rawValue: unknown;
  onOpen?: () => void;
}) {
  return (
    <div className="space-y-2">
      {onOpen ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onOpen}
            className={`inline-flex min-h-10 items-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-[10px] font-semibold tracking-[0.1em] text-[var(--bo-fg)] uppercase transition-[border-color,scale] duration-150 ease-out hover:border-[color:var(--bo-accent)] ${tapScale}`}
          >
            Open interface
          </button>
        </div>
      ) : null}
      <RawValueDisclosure value={rawValue} />
    </div>
  );
}
