/*
 * The execution-output block — the large panel above the prompt input. It is a
 * pure dispatcher: it reads the active surface from the shared session and hands
 * off to the matching renderer. Three surfaces:
 *
 *   - dev mode            → the live bash transcript.
 *   - compose · stream    → the heterogeneous block stream (`OutputStream`).
 *   - compose · build     → the graph playground (`BuildPlayground`).
 *
 * All session state lives in `PromptProvider`; this component drives nothing
 * beyond closing the build view.
 */

import { Sparkles, TerminalSquare, Workflow } from "lucide-react";

import { CadencePanel } from "@/components/cadence/primitives";
import { cn } from "@/lib/utils";

import { DevTranscript } from "../dev/dev-transcript";
import { usePrompt } from "../prompt-context";
import { BuildPlayground } from "./build/build-playground";
import { ComposeTranscript } from "./compose-transcript";
import { OutputActionsProvider } from "./output-actions";
import { OutputStream } from "./output-stream";

export function PromptOutput({ className }: { className?: string }) {
  const {
    mode,
    organizationId,
    organizationName,
    terminal,
    compose,
    outputActions,
    closeBuild,
    updateBuildGraph,
    openWorkflow,
    openCodemode,
    refreshWorkflow,
  } = usePrompt();

  const isBuild = mode === "compose" && compose.view.kind === "build";

  return (
    <CadencePanel
      className={cn(
        "flex min-h-[22rem] flex-col overflow-hidden",
        isBuild ? "h-[70vh] max-h-[70vh]" : "max-h-[60vh]",
        className,
      )}
    >
      <OutputHeader mode={mode} organizationName={organizationName} view={compose.view.kind} />

      {mode === "dev" ? (
        <DevTranscript entries={terminal.terminalHistory} scrollRef={terminal.terminalRef} />
      ) : (
        <OutputActionsProvider actions={outputActions}>
          {compose.view.kind === "build" ? (
            <BuildPlayground
              key={compose.view.sourceBlockId ?? "build"}
              graph={compose.view.graph}
              title={compose.view.title}
              onChange={updateBuildGraph}
              onClose={closeBuild}
            />
          ) : compose.status === "idle" ? (
            <EmptyState />
          ) : compose.status === "error" ? (
            <ErrorState error={compose.error} />
          ) : compose.session && organizationId ? (
            <ComposeTranscript
              orgId={organizationId}
              session={compose.session}
              prompt={compose.prompt ?? undefined}
              onShowWorkflow={openWorkflow}
              onShowCodemode={openCodemode}
              onWorkflowWritten={refreshWorkflow}
            />
          ) : (
            <OutputStream
              prompt={compose.prompt ?? undefined}
              blocks={compose.blocks}
              isComposing={compose.status === "composing"}
            />
          )}
        </OutputActionsProvider>
      )}
    </CadencePanel>
  );
}

function OutputHeader({
  mode,
  organizationName,
  view,
}: {
  mode: "compose" | "dev";
  organizationName?: string | null;
  view: "stream" | "build";
}) {
  const { icon, label } =
    mode === "dev"
      ? {
          icon: <TerminalSquare className="h-4 w-4 text-[var(--cad-brass)]" />,
          label: `Dev transcript${organizationName ? ` · ${organizationName}` : ""}`,
        }
      : view === "build"
        ? { icon: <Workflow className="h-4 w-4 text-[var(--cad-brass)]" />, label: "Build" }
        : { icon: <Sparkles className="h-4 w-4 text-[var(--cad-brass)]" />, label: "Output" };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[color:var(--cad-line)] px-5 py-3">
      <span className="flex items-center gap-2">
        {icon}
        <span className="cad-eyebrow text-[var(--cad-muted)]">{label}</span>
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-5">
      <p className="text-xs text-[var(--cad-muted-2)]">
        Compose an automation below and conduct it — the output appears here.
      </p>
    </div>
  );
}

function ErrorState({ error }: { error: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-5">
      <p className="text-xs text-[var(--cad-rose)]">{error ?? "Something went wrong."}</p>
    </div>
  );
}
