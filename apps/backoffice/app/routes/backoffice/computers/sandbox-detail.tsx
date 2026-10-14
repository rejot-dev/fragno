import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, redirect, useFetcher, useNavigation, useOutletContext } from "react-router";

import type { SandboxCommandResult } from "@/sandbox/contracts";

import type { Route } from "./+types/sandbox-detail";
import type { SandboxesLayoutContext } from "./layout-context";
import { sandboxPath, sandboxesPath } from "./paths";
import type { SandboxView } from "./sandbox-model";
import { RelativeTime, SandboxActivity, SandboxStatusLight } from "./sandbox-status";
import {
  readText,
  requireScopedSandboxRuntime,
  secondsToMilliseconds,
  startSandboxFromForm,
  toErrorMessage,
} from "./sandboxes.server";

type CommandRun = {
  intent: "exec";
  command: string;
  timeoutMs: number | undefined;
  result: SandboxCommandResult;
};

type SandboxActionError = { intent: "resume" | "kill"; message: string };

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Sandbox ${params.sandboxId}` }];
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { sandboxRuntime, routeScope } = await requireScopedSandboxRuntime({
    request,
    params,
    context,
  });
  const { sandboxId } = params;
  const formData = await request.formData();
  const intent = readText(formData.get("intent"));

  if (intent === "resume") {
    const result = await startSandboxFromForm(sandboxRuntime, formData);
    return result.ok
      ? redirect(sandboxPath(routeScope, result.sandboxId))
      : ({ intent: "resume", message: result.message } satisfies SandboxActionError);
  }

  if (intent === "exec") {
    const command = readText(formData.get("command"));
    const timeoutMs = secondsToMilliseconds(readText(formData.get("timeoutSeconds")));
    if (!command) {
      return {
        intent: "exec",
        command: "",
        timeoutMs,
        result: {
          ok: false,
          code: "command_required",
          reason: "command_failed",
          message: "Command cannot be empty.",
          retryable: false,
        },
      } satisfies CommandRun;
    }

    try {
      const result = await sandboxRuntime.executeCommand({ sandboxId, command, timeoutMs });
      return { intent: "exec", command, timeoutMs, result } satisfies CommandRun;
    } catch (error) {
      return {
        intent: "exec",
        command,
        timeoutMs,
        result: {
          ok: false,
          code: "internal_error",
          reason: "internal_error",
          message: toErrorMessage(error),
          retryable: false,
        },
      } satisfies CommandRun;
    }
  }

  if (intent === "kill") {
    try {
      await sandboxRuntime.killSandbox({ sandboxId });
      return redirect(sandboxPath(routeScope, sandboxId));
    } catch (error) {
      return { intent: "kill", message: toErrorMessage(error) } satisfies SandboxActionError;
    }
  }

  throw new Response("Unsupported sandbox action", { status: 400 });
}

export default function BackofficeSandboxDetail({ params, actionData }: Route.ComponentProps) {
  const { routeScope, sandboxes } = useOutletContext<SandboxesLayoutContext>();
  const sandbox = sandboxes.find((instance) => instance.id === params.sandboxId);
  if (!sandbox) {
    return (
      <BackofficeSystemState
        tone="empty"
        label="Not found"
        title="This sandbox is no longer available."
        description={params.sandboxId}
        actions={
          <ButtonLink variant="secondary" to={sandboxesPath(routeScope)}>
            All sandboxes
          </ButtonLink>
        }
      />
    );
  }

  return (
    <>
      <section className="bo-panel-surface bg-[var(--bo-panel)]">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            <Link
              to={sandboxesPath(routeScope)}
              className="text-xs text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
            >
              ← Sandboxes
            </Link>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3">
              <h2 className="truncate font-mono text-xl font-semibold text-[var(--bo-fg)]">
                {sandbox.id}
              </h2>
              <SandboxStatusLight status={sandbox.status} />
            </div>
          </div>
          <SandboxLifecycleAction sandbox={sandbox} />
        </div>
        {actionData && actionData.intent !== "exec" ? (
          <p role="alert" className="px-4 pt-3 text-sm text-[var(--bo-failed)]">
            {actionData.message}
          </p>
        ) : null}
        {sandbox.status === "error" && sandbox.lastError ? (
          <p className="mx-4 mt-3 border border-[color:var(--bo-failed)]/40 bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
            {sandbox.lastError}
          </p>
        ) : null}
        <SandboxDetails sandbox={sandbox} />
      </section>
      <SandboxConsole
        // Each sandbox keeps its own transcript; switching sandboxes starts a fresh one.
        key={sandbox.id}
        sandbox={sandbox}
      />
    </>
  );
}

/** The one lifecycle step that makes sense from the sandbox's current status. */
function SandboxLifecycleAction({ sandbox }: { sandbox: SandboxView }) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  if (sandbox.status === "stopping") {
    return (
      <Button variant="secondary" disabled>
        Stopping…
      </Button>
    );
  }

  if (sandbox.status === "stopped" || sandbox.status === "error") {
    return (
      <Form method="post">
        <input type="hidden" name="intent" value="resume" />
        <input type="hidden" name="id" value={sandbox.id} />
        <input type="hidden" name="image" value={sandbox.image} />
        <input type="hidden" name="instanceType" value={sandbox.instanceType} />
        {sandbox.keepAlive ? <input type="hidden" name="keepAlive" value="on" /> : null}
        <input type="hidden" name="sleepAfter" value={sandbox.sleepAfter ?? ""} />
        <input type="hidden" name="startupCommand" value={sandbox.startupCommand} />
        <Button variant="accent" type="submit" disabled={submitting}>
          {submitting ? "Starting…" : sandbox.workspaceSaved ? "Resume" : "Start"}
        </Button>
      </Form>
    );
  }

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="kill" />
      <Button
        variant="secondary"
        type="submit"
        disabled={submitting}
        title="Saves the workspace, then stops the sandbox"
      >
        {submitting ? "Stopping…" : "Stop"}
      </Button>
    </Form>
  );
}

function SandboxDetails({ sandbox }: { sandbox: SandboxView }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[color:var(--bo-border)] px-4 py-3 md:grid-cols-3 xl:grid-cols-6">
      <Detail label="Image">{sandbox.image}</Detail>
      <Detail label="Size">{sandbox.instanceType}</Detail>
      <Detail label="Started">
        {sandbox.startedAt ? <RelativeTime date={sandbox.startedAt} /> : "—"}
      </Detail>
      {/* A failed sandbox explains itself in the error banner above. */}
      {sandbox.status === "error" ? null : (
        <Detail label="Activity">
          <SandboxActivity sandbox={sandbox} />
        </Detail>
      )}
      <Detail label="Workspace">{sandbox.workspaceSaved ? "Saved" : "Not saved"}</Detail>
      <Detail label="Startup command">
        <code className="font-mono text-xs">{sandbox.startupCommand}</code>
      </Detail>
    </dl>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">{label}</dt>
      <dd className="mt-1 truncate text-sm text-[var(--bo-fg)]">{children}</dd>
    </div>
  );
}

const COMMAND_PLACEHOLDERS: Record<SandboxView["status"], string> = {
  requested: "Waiting for the sandbox to start…",
  starting: "Waiting for the sandbox to start…",
  running: "ls -la",
  stopping: "The sandbox is stopping",
  stopped: "Start the sandbox to run commands",
  error: "Start the sandbox to run commands",
};

function SandboxConsole({ sandbox }: { sandbox: SandboxView }) {
  const fetcher = useFetcher<typeof action>();
  const [command, setCommand] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [recordedResult, setRecordedResult] = useState(fetcher.data);
  if (fetcher.data !== recordedResult) {
    setRecordedResult(fetcher.data);
    if (fetcher.data?.intent === "exec") {
      setRuns([...runs, fetcher.data]);
    }
  }
  const pendingCommand =
    fetcher.state === "idle" ? null : String(fetcher.formData?.get("command") ?? "");
  const running = sandbox.status === "running";

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [runs.length, pendingCommand]);

  return (
    <section className="bo-panel-surface flex flex-col bg-[var(--bo-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Console</p>
        <label className="flex items-center gap-2 text-xs text-[var(--bo-muted)]">
          Timeout
          <Input
            type="number"
            min={1}
            step={1}
            value={timeoutSeconds}
            onChange={(event) => {
              setTimeoutSeconds(event.target.value);
            }}
            placeholder="default"
            aria-label="Command timeout in seconds"
            className="min-h-8 w-24 py-1 text-xs"
          />
          s
        </label>
      </div>

      <div
        ref={transcriptRef}
        className="backoffice-scroll max-h-[60vh] min-h-64 space-y-4 overflow-auto border-y border-[color:var(--bo-border)] bg-[rgba(var(--bo-grid),0.08)] px-4 py-3 font-mono text-xs"
      >
        {runs.length === 0 && pendingCommand === null ? (
          <p className="text-[var(--bo-muted-2)]">Command output appears here.</p>
        ) : null}
        {runs.map((run, index) => (
          // Runs only append, so a run's position identifies it.
          // oxlint-disable-next-line react/no-array-index-key
          <CommandRunEntry key={index} run={run} />
        ))}
        {pendingCommand !== null ? (
          <div className="flex gap-2 text-[var(--bo-fg)]">
            <span className="text-[var(--bo-muted-2)]">$</span>
            <span className="min-w-0 break-all">{pendingCommand}</span>
            <span className="ml-auto shrink-0 text-[var(--bo-muted-2)]">running…</span>
          </div>
        ) : null}
      </div>

      <form
        className="flex items-center gap-2 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!command.trim()) {
            return;
          }
          void fetcher.submit({ intent: "exec", command, timeoutSeconds }, { method: "post" });
          setCommand("");
        }}
      >
        <span className="font-mono text-sm text-[var(--bo-muted-2)]" aria-hidden="true">
          $
        </span>
        <Input
          value={command}
          onChange={(event) => {
            setCommand(event.target.value);
          }}
          disabled={!running}
          placeholder={COMMAND_PLACEHOLDERS[sandbox.status]}
          aria-label="Command"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono"
        />
        <Button
          variant="accent"
          type="submit"
          disabled={!running || !command.trim() || pendingCommand !== null}
        >
          Run
        </Button>
      </form>
    </section>
  );
}

function CommandRunEntry({ run }: { run: CommandRun }) {
  const { result } = run;
  return (
    <div className="space-y-1">
      <div className="flex gap-2 text-[var(--bo-fg)]">
        <span className="text-[var(--bo-muted-2)]">$</span>
        <span className="min-w-0 break-all">{run.command}</span>
        <span
          className={`ml-auto shrink-0 ${
            result.ok && result.exitCode === 0
              ? "text-[var(--bo-muted-2)]"
              : "text-[var(--bo-failed)]"
          }`}
        >
          {commandOutcomeLabel(result)}
        </span>
      </div>
      {result.stdout ? (
        <pre className="break-all whitespace-pre-wrap text-[var(--bo-fg)]">{result.stdout}</pre>
      ) : null}
      {result.stderr ? (
        <pre className="break-all whitespace-pre-wrap text-[var(--bo-failed)]">{result.stderr}</pre>
      ) : null}
      {result.ok ? null : (
        <p className="text-[var(--bo-failed)]">
          {result.message}
          {result.retryable ? " Retrying may succeed." : ""}
        </p>
      )}
    </div>
  );
}

// A failure before the command exits has no exit code, so its reason stands in.
function commandOutcomeLabel(result: SandboxCommandResult): string {
  if (result.exitCode !== undefined) {
    return `exit ${result.exitCode}`;
  }
  return result.ok ? "" : result.reason;
}
