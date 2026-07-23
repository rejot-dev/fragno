import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from "react-router";

import { and, eq, like, useLiveQuery } from "@tanstack/react-db";

import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxCommandResult,
  type SandboxInstanceStatus,
  type SandboxInstanceSummary,
  type StartSandboxOptions,
} from "@/sandbox/contracts";
import { parseSleepAfterInput } from "@/sandbox/sleep-after";
import { getScopedSandboxRuntime } from "@/worker-runtime/sandbox-manager";

import type { Route } from "./+types/sandboxes";
import { fetchAutomationProjects, toExternalId } from "./data.server";
import { automationScopeFromRouteParams, automationScopeTabPath } from "./scope";
import type { AutomationLayoutContext } from "./shared";

type SandboxView = "new" | "detail";

type NewSandboxFormValues = {
  id: string;
  keepAlive: boolean;
  sleepAfter: string;
  startupCommand: string;
  startupTimeoutMs: string;
};

type StartActionError = {
  intent: "start";
  ok: false;
  message: string;
  values: NewSandboxFormValues;
};

type ExecuteActionResult = {
  intent: "exec";
  sandboxId: string;
  command: string;
  timeoutMs?: number;
  result: SandboxCommandResult;
};

type KillActionError = {
  intent: "kill";
  ok: false;
  sandboxId: string;
  message: string;
};

const DEFAULT_NEW_SANDBOX_VALUES: NewSandboxFormValues = {
  id: "",
  keepAlive: false,
  sleepAfter: "15m",
  startupCommand: "true",
  startupTimeoutMs: "15000",
};

const STATUS_LABELS: Record<SandboxInstanceStatus, string> = {
  requested: "Requested",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
};

const STATUS_CLASSES: Record<SandboxInstanceStatus, string> = {
  requested:
    "border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
  starting:
    "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
  running:
    "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
  stopping:
    "border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
  stopped: "border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted-2)]",
  error: "border border-red-300 bg-red-100 text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.14)]",
};

type SandboxPathOptions = { view?: "new" } | { view: "detail"; sandboxId: string };

export function meta() {
  return [
    { title: "Automation sandboxes" },
    {
      name: "description",
      content: "Manage Cloudflare sandboxes for the selected automation scope.",
    },
  ];
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = readText(formData.get("intent"));
  const scope = await requireSandboxScopeAccess({ request, params, context });
  const sandboxRuntime = getScopedSandboxRuntime(context, scope);

  if (intent === "start") {
    const values = readNewSandboxFormValues(formData);
    const sandboxId = values.id || createSandboxId();
    const parsedSleepAfter = parseSleepAfterInput(values.sleepAfter);

    if (!parsedSleepAfter.ok) {
      return {
        intent: "start",
        ok: false,
        message: parsedSleepAfter.message,
        values,
      } satisfies StartActionError;
    }

    const options: StartSandboxOptions = {
      id: sandboxId,
      keepAlive: values.keepAlive,
      sleepAfter: parsedSleepAfter.value,
      startupCommand: values.startupCommand || "true",
      startupTimeoutMs: toPositiveIntegerOrUndefined(values.startupTimeoutMs),
    };

    let instance: SandboxInstanceSummary | null = null;

    try {
      instance = await sandboxRuntime.startSandbox(options);
      return redirect(toSandboxPathFromUrl(url, { view: "detail", sandboxId: instance.id }));
    } catch (error) {
      if (instance?.id) {
        try {
          await sandboxRuntime.killSandbox({ sandboxId: instance.id });
        } catch (cleanupError) {
          console.error("Failed to cleanup partially bootstrapped sandbox", {
            sandboxId: instance.id,
            message: toErrorMessage(cleanupError),
          });
        }
      }

      return {
        intent: "start",
        ok: false,
        message: toErrorMessage(error),
        values,
      } satisfies StartActionError;
    }
  }

  if (intent === "exec") {
    const sandboxId = readText(formData.get("sandboxId"));
    const command = readText(formData.get("command"));
    const timeoutMs = toPositiveIntegerOrUndefined(readText(formData.get("timeoutMs")));

    if (!sandboxId) {
      return {
        intent: "exec",
        sandboxId: "",
        command,
        timeoutMs,
        result: {
          ok: false,
          reason: "internal_error",
          message: "Sandbox id is required.",
          retryable: false,
        },
      } satisfies ExecuteActionResult;
    }

    if (!command) {
      return {
        intent: "exec",
        sandboxId,
        command: "",
        timeoutMs,
        result: {
          ok: false,
          reason: "command_failed",
          message: "Command cannot be empty.",
          retryable: false,
        },
      } satisfies ExecuteActionResult;
    }

    try {
      const result = await sandboxRuntime.executeCommand({ sandboxId, command, timeoutMs });
      return {
        intent: "exec",
        sandboxId,
        command,
        timeoutMs,
        result,
      } satisfies ExecuteActionResult;
    } catch (error) {
      return {
        intent: "exec",
        sandboxId,
        command,
        timeoutMs,
        result: {
          ok: false,
          reason: "internal_error",
          message: toErrorMessage(error),
          retryable: false,
        },
      } satisfies ExecuteActionResult;
    }
  }

  if (intent === "kill") {
    const sandboxId = readText(formData.get("sandboxId"));
    if (!sandboxId) {
      return {
        intent: "kill",
        ok: false,
        sandboxId: "",
        message: "Sandbox id is required.",
      } satisfies KillActionError;
    }

    try {
      await sandboxRuntime.killSandbox({ sandboxId });
      return redirect(toSandboxPathFromUrl(url, { view: "new" }));
    } catch (error) {
      return {
        intent: "kill",
        ok: false,
        sandboxId,
        message: toErrorMessage(error),
      } satisfies KillActionError;
    }
  }

  throw new Response("Unsupported sandbox action", { status: 400 });
}

const isSandboxStatus = (status: string): status is SandboxInstanceStatus =>
  status === "requested" ||
  status === "starting" ||
  status === "running" ||
  status === "stopping" ||
  status === "stopped" ||
  status === "error";

const sandboxScopeId = (scope: AutomationLayoutContext["selectedScope"]): string => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return scope.orgId;
    case "project":
      return backofficeScopeSinglePathSegment({
        kind: "project",
        orgId: scope.orgId,
        projectId: scope.projectId,
      });
    case "user":
      return backofficeScopeSinglePathSegment({ kind: "user", userId: scope.userId });
  }

  throw new Error("Unsupported automation sandbox scope.");
};

export default function BackofficeAutomationSandboxes() {
  const { selectedScope, collections } = useOutletContext<AutomationLayoutContext>();
  const sandboxPrefix = `${sandboxScopeId(selectedScope)}::`;
  const sandboxesQuery = useLiveQuery(
    (query) =>
      query
        .from({ instance: collections.sandboxInstances })
        .where(({ instance }) =>
          and(
            eq(instance.provider, CLOUDFLARE_SANDBOX_PROVIDER),
            like(instance.id, `${sandboxPrefix}%`),
          ),
        )
        .orderBy(({ instance }) => instance.id, "asc")
        .select(({ instance }) => ({ id: instance.id, status: instance.status })),
    [collections.sandboxInstances, sandboxPrefix],
  );
  const sandboxes: SandboxInstanceSummary[] = (sandboxesQuery.data ?? []).flatMap((instance) => {
    const id = instance.id.slice(sandboxPrefix.length);
    return id && isSandboxStatus(instance.status) ? [{ id, status: instance.status }] : [];
  });
  const sandboxesError = sandboxesQuery.isError
    ? toErrorMessage(collections.sandboxInstances.utils.getLastError())
    : null;
  const [searchParams] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const activeIntent = navigation.formData?.get("intent");
  const isStarting = navigation.state === "submitting" && activeIntent === "start";
  const isExecuting = navigation.state === "submitting" && activeIntent === "exec";
  const isKilling = navigation.state === "submitting" && activeIntent === "kill";
  const basePath = automationScopeTabPath(selectedScope, "sandboxes");
  const requestedView = searchParams.get("view") === "new" ? "new" : "detail";
  const requestedSandboxId = readText(searchParams.get("sandbox"));
  const fallbackSandbox =
    sandboxes.find((instance) => instance.status !== "stopped") ?? sandboxes[0] ?? null;
  const view: SandboxView = requestedView === "new" ? "new" : fallbackSandbox ? "detail" : "new";
  const selectedSandboxId =
    view === "detail" ? requestedSandboxId || fallbackSandbox?.id || null : null;
  const selectedSandbox = selectedSandboxId
    ? (sandboxes.find((instance) => instance.id === selectedSandboxId) ?? null)
    : null;
  const effectiveLoadError = sandboxesError && sandboxes.length === 0 ? sandboxesError : null;

  const startError = actionData?.intent === "start" && !actionData.ok ? actionData.message : null;
  const startValues =
    actionData?.intent === "start" && !actionData.ok
      ? actionData.values
      : DEFAULT_NEW_SANDBOX_VALUES;

  const commandRun =
    actionData?.intent === "exec" && selectedSandboxId && actionData.sandboxId === selectedSandboxId
      ? actionData
      : null;

  const killError =
    actionData?.intent === "kill" &&
    !actionData.ok &&
    selectedSandboxId &&
    actionData.sandboxId === selectedSandboxId
      ? actionData.message
      : null;

  const commandDisabled = selectedSandbox?.status !== "running";

  return (
    <section className="grid w-full max-w-7xl gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Sandboxes
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Instances</h2>
        </div>

        <div className="mt-4 space-y-2">
          <Link
            to={toSandboxPath(basePath, { view: "new" })}
            preventScrollReset
            aria-current={view === "new" ? "page" : undefined}
            className={
              view === "new"
                ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            }
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--bo-fg)]">Create sandbox</p>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                New
              </span>
            </div>
          </Link>

          {sandboxesQuery.isLoading && sandboxes.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-xs text-[var(--bo-muted)]">
              Loading sandbox instances…
            </div>
          ) : !effectiveLoadError && sandboxes.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-xs text-[var(--bo-muted)]">
              No sandbox instances yet.
            </div>
          ) : (
            sandboxes.map((instance) => {
              const isSelected =
                view === "detail" && selectedSandboxId && selectedSandboxId === instance.id;
              return (
                <Link
                  key={instance.id}
                  to={toSandboxPath(basePath, { view: "detail", sandboxId: instance.id })}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    isSelected
                      ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.14)]"
                      : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-semibold">{instance.id}</p>
                    <span
                      className={`px-2.5 py-1 text-[9px] font-semibold tracking-[0.16em] whitespace-nowrap uppercase ${STATUS_CLASSES[instance.status]}`}
                    >
                      {STATUS_LABELS[instance.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                    Automation-scoped sandbox runtime
                  </p>
                </Link>
              );
            })
          )}
        </div>
      </aside>

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]">
        {effectiveLoadError ? (
          <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
            {effectiveLoadError}
          </div>
        ) : (
          <>
            {sandboxesError ? (
              <div className="mb-4 border border-red-300 bg-red-100 p-3 text-sm text-red-700">
                Could not synchronize all sandbox updates: {sandboxesError}
              </div>
            ) : null}
            {view === "new" ? (
              <NewSandboxView values={startValues} error={startError} isStarting={isStarting} />
            ) : selectedSandbox ? (
              <SandboxDetailView
                sandbox={selectedSandbox}
                commandRun={commandRun}
                commandDisabled={commandDisabled}
                killError={killError}
                isExecuting={isExecuting}
                isKilling={isKilling}
              />
            ) : (
              <div className="space-y-4">
                <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                  Sandbox not found
                </p>
                <p className="text-sm text-[var(--bo-muted)]">
                  The selected sandbox instance is no longer available for this automation scope.
                </p>
                <Link
                  to={toSandboxPath(basePath, { view: "new" })}
                  className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Create new sandbox
                </Link>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function NewSandboxView({
  values,
  error,
  isStarting,
}: {
  values: NewSandboxFormValues;
  error: string | null;
  isStarting: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          New sandbox
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--bo-fg)]">
          Provision sandbox
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--bo-muted)]">
          Configure startup behavior, then create an isolated Cloudflare sandbox instance.
        </p>
      </div>

      <Form method="post" className="space-y-5">
        <input type="hidden" name="intent" value="start" />

        {error ? (
          <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Sandbox id (optional)
            </span>
            <input
              name="id"
              defaultValue={values.id}
              placeholder="auto-generated"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] tracking-normal text-[var(--bo-muted)] normal-case">
              Leave blank to auto-generate. This id is used to reference and reopen the sandbox. IDs
              are always normalized automatically.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Sleep after
            </span>
            <input
              name="sleepAfter"
              type="text"
              defaultValue={values.sleepAfter}
              placeholder="15m or 900"
              inputMode="text"
              autoComplete="off"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] tracking-normal text-[var(--bo-muted)] normal-case">
              Idle timeout before the sandbox can sleep. Accepts duration text like `15m` or a
              seconds value like `900`.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Startup command
            </span>
            <input
              name="startupCommand"
              defaultValue={values.startupCommand}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] tracking-normal text-[var(--bo-muted)] normal-case">
              Command executed immediately after provisioning. If it fails, sandbox startup is
              marked as failed.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Startup timeout (ms)
            </span>
            <input
              name="startupTimeoutMs"
              type="number"
              min={1}
              step={1}
              defaultValue={values.startupTimeoutMs}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] tracking-normal text-[var(--bo-muted)] normal-case">
              Maximum time allowed for the startup command before it times out.
            </span>
          </label>
        </div>

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-3">
          <p className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Runtime policy
          </p>
          <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3">
            <label htmlFor="keepAlive" className="flex cursor-pointer items-center gap-2">
              <input
                id="keepAlive"
                name="keepAlive"
                type="checkbox"
                defaultChecked={values.keepAlive}
                className="h-4 w-4 accent-[var(--bo-accent)]"
              />
              <span className="text-xs tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                Keep alive
              </span>
            </label>
            <p className="mt-2 text-[11px] text-[var(--bo-muted)]">
              Requests a warm instance policy so the sandbox stays active between requests and
              avoids cold starts.
            </p>
          </div>
        </div>

        <div className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
          <button
            type="submit"
            disabled={isStarting}
            className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isStarting ? "Starting..." : "Start sandbox"}
          </button>
          <p className="text-xs text-[var(--bo-muted)]">
            Starts provisioning and runs the startup command before the sandbox is available.
          </p>
        </div>
      </Form>
    </div>
  );
}

function SandboxDetailView({
  sandbox,
  commandRun,
  commandDisabled,
  killError,
  isExecuting,
  isKilling,
}: {
  sandbox: SandboxInstanceSummary;
  commandRun: ExecuteActionResult | null;
  commandDisabled: boolean;
  killError: string | null;
  isExecuting: boolean;
  isKilling: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Sandbox details
          </p>
          <h2 className="mt-2 truncate font-mono text-xl font-semibold text-[var(--bo-fg)] md:text-2xl">
            {sandbox.id}
          </h2>
          <p className="mt-2 text-xs text-[var(--bo-muted)]">
            Inspect runtime status and run commands against this instance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Form method="post" className="contents">
            <input type="hidden" name="intent" value="kill" />
            <input type="hidden" name="sandboxId" value={sandbox.id} />
            <button
              type="submit"
              disabled={isKilling}
              className="inline-flex border border-red-300 bg-red-100 px-3 py-1 text-[10px] font-semibold tracking-[0.16em] text-red-700 uppercase transition-colors hover:border-red-400 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isKilling ? "Stopping..." : "Stop"}
            </button>
          </Form>
          <span
            className={`px-2.5 py-1 text-[10px] font-semibold tracking-[0.16em] uppercase ${STATUS_CLASSES[sandbox.status]}`}
          >
            {STATUS_LABELS[sandbox.status]}
          </span>
          {killError ? <p className="basis-full text-xs text-red-700">{killError}</p> : null}
        </div>
      </div>

      <div className="space-y-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div>
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Command runner
          </p>
          <p className="mt-1 text-xs text-[var(--bo-muted)]">
            Execute shell commands in this sandbox and capture stdout/stderr plus exit status.
          </p>
          {commandDisabled ? (
            <p className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1.5 text-xs text-[var(--bo-muted)]">
              Commands are only enabled while the sandbox status is running.
            </p>
          ) : null}
        </div>

        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="exec" />
          <input type="hidden" name="sandboxId" value={sandbox.id} />

          <textarea
            name="command"
            aria-label="Sandbox command"
            required
            rows={3}
            defaultValue={commandRun?.command ?? ""}
            placeholder="pnpm test"
            className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <p className="text-xs text-[var(--bo-muted)]">
            Enter a single command exactly as it should run in the sandbox shell.
          </p>

          <div className="flex flex-wrap items-end gap-4">
            <label className="block min-w-56 space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
              <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                Timeout (ms)
              </span>
              <input
                name="timeoutMs"
                type="number"
                min={1}
                step={1}
                defaultValue={commandRun?.timeoutMs ? String(commandRun.timeoutMs) : ""}
                placeholder="15000"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
              />
              <span className="block text-[11px] tracking-normal text-[var(--bo-muted)] normal-case">
                Optional command timeout. Leave blank for runtime default.
              </span>
            </label>

            <button
              type="submit"
              disabled={commandDisabled || isExecuting}
              className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isExecuting ? "Running..." : "Run command"}
            </button>
          </div>
          <p className="text-xs text-[var(--bo-muted)]">
            If the sandbox exits before completion, the result will be marked as terminated and
            retryable.
          </p>
        </Form>
      </div>

      <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Output</p>
        <p className="text-xs text-[var(--bo-muted)]">
          Displays the most recent command result for the currently selected sandbox.
        </p>
        {commandRun ? (
          <CommandOutput command={commandRun.command} result={commandRun.result} />
        ) : (
          <p className="text-sm text-[var(--bo-muted)]">Run a command to view stdout and stderr.</p>
        )}
      </div>
    </div>
  );
}

function CommandOutput({ command, result }: { command: string; result: SandboxCommandResult }) {
  return (
    <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--bo-muted)]">
        <span className="text-[var(--bo-muted-2)]">Command:</span>
        <code className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[var(--bo-fg)]">
          {command}
        </code>
      </div>

      {result.ok ? (
        <p className="inline-flex w-fit border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
          Exit code {result.exitCode}
        </p>
      ) : (
        <p className="inline-flex w-fit border border-red-300 bg-red-100 px-2 py-1 text-xs text-red-700">
          {result.reason} {result.retryable ? "(retryable)" : "(non-retryable)"}: {result.message}
        </p>
      )}

      <LogBlock label="stdout" value={result.stdout} />
      <LogBlock label="stderr" value={result.stderr} />
    </div>
  );
}

function LogBlock({ label, value }: { label: "stdout" | "stderr"; value?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <pre className="backoffice-scroll max-h-56 overflow-auto border border-[color:var(--bo-border)] bg-[rgba(var(--bo-grid),0.08)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)]">
        {value?.trim() ? value : "(empty)"}
      </pre>
    </div>
  );
}

function toSandboxPath(basePath: string, options: SandboxPathOptions = {}) {
  const params = new URLSearchParams();
  if (options.view === "new") {
    params.set("view", "new");
  } else if (options.view === "detail") {
    params.set("sandbox", options.sandboxId);
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function toSandboxPathFromUrl(url: URL, options: SandboxPathOptions = {}) {
  return toSandboxPath(url.pathname.replace(/\/+$/, ""), options);
}

async function requireSandboxScopeAccess({
  request,
  params,
  context,
}: Pick<Route.LoaderArgs, "request" | "params" | "context">): Promise<BackofficeRoutableScope> {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const scope = automationScopeFromRouteParams(params);
  if (scope.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "user") {
    if (scope.userId !== me.user.id) {
      throw new Response("Not Found", { status: 404 });
    }
    return scope;
  }

  const hasOrgAccess = me.organizations.some((entry) => entry.organization.id === scope.orgId);
  if (!hasOrgAccess) {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "project") {
    const projectsResult = await fetchAutomationProjects(request, context, scope.orgId);
    if (projectsResult.projectsError) {
      throw Response.json(
        {
          code: "AUTOMATION_PROJECTS_UNAVAILABLE",
          message: projectsResult.projectsError,
        },
        { status: 502, statusText: "Bad Gateway" },
      );
    }

    const project = projectsResult.projects.find(
      (entry) => toExternalId(entry.id) === scope.projectId,
    );
    if (!project || project.archivedAt) {
      throw new Response("Not Found", { status: 404 });
    }
  }

  return scope;
}

function readNewSandboxFormValues(formData: FormData): NewSandboxFormValues {
  return {
    id: readText(formData.get("id")),
    keepAlive: formData.get("keepAlive") === "on",
    sleepAfter: readText(formData.get("sleepAfter")),
    startupCommand:
      readText(formData.get("startupCommand")) || DEFAULT_NEW_SANDBOX_VALUES.startupCommand,
    startupTimeoutMs:
      readText(formData.get("startupTimeoutMs")) || DEFAULT_NEW_SANDBOX_VALUES.startupTimeoutMs,
  };
}

function toPositiveIntegerOrUndefined(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function readText(value: FormDataEntryValue | string | null) {
  return typeof value === "string" ? value.trim() : "";
}

function createSandboxId() {
  const random =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `cf-sbx-${Date.now().toString(36)}-${random}`;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
