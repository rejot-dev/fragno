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

import { cn } from "@/lib/utils";

import { DevTranscript } from "../dev/dev-transcript";
import { usePrompt } from "../prompt-context";
import { BuildPlayground } from "./build/build-playground";
import { ComposeTranscript } from "./compose-transcript";
import { OutputActionsProvider } from "./output-actions";
import { OutputStream } from "./output-stream";
import { SessionHistory } from "./session-history";

export function PromptOutput({ className }: { className?: string }) {
  const {
    mode,
    piCollectionSource,
    terminal,
    compose,
    history,
    activeSessionId,
    resumeSession,
    startNewSession,
    outputActions,
    closeBuild,
    updateBuildGraph,
    openWorkflow,
    openCodemode,
    refreshWorkflow,
  } = usePrompt();

  // History is a compose-only affordance — dev mode has its own transcript.
  const showHistory = mode === "compose" && compose.view.kind !== "build";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {showHistory ? (
        <div className="mx-auto flex w-full max-w-4xl justify-end px-5 pt-3">
          <SessionHistory
            history={history}
            activeSessionId={activeSessionId}
            onResume={resumeSession}
            onNew={startNewSession}
          />
        </div>
      ) : null}

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
          ) : compose.session && piCollectionSource ? (
            <ComposeTranscript
              source={piCollectionSource}
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
