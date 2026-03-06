import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { getSandboxManager } from "@/cloudflare/sandbox-manager";
import { BackofficePageHeader } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth-server";
import { parseSleepAfterInput } from "@/sandbox/sleep-after";
import type {
  SandboxCommandResult,
  SandboxInstanceStatus,
  SandboxInstanceSummary,
  StartSandboxOptions,
} from "@/sandbox/contracts";
import type { Route } from "./+types/cf-sandbox";

type CfSandboxView = "new" | "detail";

type CfSandboxLoaderData = {
  activeInstances: SandboxInstanceSummary[];
  selectedSandbox: SandboxInstanceSummary | null;
  selectedSandboxId: string | null;
  view: CfSandboxView;
  loadError: string | null;
};

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
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

const STATUS_CLASSES: Record<SandboxInstanceStatus, string> = {
  running:
    "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.18)]",
  stopped: "border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted-2)]",
  error: "border border-red-300 bg-red-100 text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.14)]",
};

const ORG_REQUIRED_MESSAGE =
  "No active organisation selected. Select an organisation in Backoffice and try again.";

export function meta() {
  return [
    { title: "Backoffice CF Sandbox" },
    { name: "description", content: "Manage the Cloudflare sandbox environment." },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const organizationId = await resolveActiveOrganizationId(request, context);
  if (!organizationId) {
    return {
      activeInstances: [],
      selectedSandbox: null,
      selectedSandboxId: null,
      view: "new",
      loadError: ORG_REQUIRED_MESSAGE,
    } satisfies CfSandboxLoaderData;
  }

  const manager = getSandboxManager(context, organizationId);
  const searchParams = new URL(request.url).searchParams;
  const requestedView = searchParams.get("view") === "new" ? "new" : "detail";
  const requestedSandboxId = readText(searchParams.get("sandbox"));

  try {
    const allInstances = await manager.listInstances();
    const activeInstances = allInstances.filter((instance) => instance.status !== "stopped");

    if (requestedView === "new") {
      return {
        activeInstances,
        selectedSandbox: null,
        selectedSandboxId: null,
        view: "new",
        loadError: null,
      } satisfies CfSandboxLoaderData;
    }

    if (requestedSandboxId) {
      return {
        activeInstances,
        selectedSandbox:
          allInstances.find((instance) => instance.id === requestedSandboxId) ?? null,
        selectedSandboxId: requestedSandboxId,
        view: "detail",
        loadError: null,
      } satisfies CfSandboxLoaderData;
    }

    const fallback = activeInstances[0] ?? null;
    return {
      activeInstances,
      selectedSandbox: fallback,
      selectedSandboxId: fallback?.id ?? null,
      view: fallback ? "detail" : "new",
      loadError: null,
    } satisfies CfSandboxLoaderData;
  } catch (error) {
    return {
      activeInstances: [],
      selectedSandbox: null,
      selectedSandboxId: null,
      view: "new",
      loadError: toErrorMessage(error),
    } satisfies CfSandboxLoaderData;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = readText(formData.get("intent"));
  const organizationId = await resolveActiveOrganizationId(request, context);

  if (!organizationId) {
    if (intent === "start") {
      return {
        intent: "start",
        ok: false,
        message: ORG_REQUIRED_MESSAGE,
        values: readNewSandboxFormValues(formData),
      } satisfies StartActionError;
    }

    if (intent === "exec") {
      return {
        intent: "exec",
        sandboxId: readText(formData.get("sandboxId")),
        command: readText(formData.get("command")),
        timeoutMs: toPositiveIntegerOrUndefined(readText(formData.get("timeoutMs"))),
        result: {
          ok: false,
          reason: "internal_error",
          message: ORG_REQUIRED_MESSAGE,
          retryable: false,
        },
      } satisfies ExecuteActionResult;
    }

    if (intent === "kill") {
      return {
        intent: "kill",
        ok: false,
        sandboxId: readText(formData.get("sandboxId")),
        message: ORG_REQUIRED_MESSAGE,
      } satisfies KillActionError;
    }

    throw new Response(ORG_REQUIRED_MESSAGE, { status: 400 });
  }

  const manager = getSandboxManager(context, organizationId);

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

    try {
      const instance = await manager.startInstance(options);
      return redirect(toCfSandboxPath({ sandboxId: instance.id }));
    } catch (error) {
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
      const handle = await manager.getHandle(sandboxId);
      if (!handle) {
        return {
          intent: "exec",
          sandboxId,
          command,
          timeoutMs,
          result: {
            ok: false,
            reason: "sandbox_unavailable",
            message: `Sandbox "${sandboxId}" is unavailable.`,
            retryable: true,
          },
        } satisfies ExecuteActionResult;
      }

      const result = await handle.executeCommand(command, { timeoutMs });
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
      await manager.killInstance(sandboxId);
      return redirect(toCfSandboxPath({ view: "new" }));
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

export default function BackofficeEnvironmentCfSandbox() {
  const { activeInstances, selectedSandbox, selectedSandboxId, view, loadError } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const activeIntent = navigation.formData?.get("intent");
  const isStarting = navigation.state === "submitting" && activeIntent === "start";
  const isExecuting = navigation.state === "submitting" && activeIntent === "exec";
  const isKilling = navigation.state === "submitting" && activeIntent === "kill";

  const startError =
    actionData?.intent === "start" && actionData.ok === false ? actionData.message : null;
  const startValues =
    actionData?.intent === "start" && actionData.ok === false
      ? actionData.values
      : DEFAULT_NEW_SANDBOX_VALUES;

  const commandRun =
    actionData?.intent === "exec" && selectedSandboxId && actionData.sandboxId === selectedSandboxId
      ? actionData
      : null;

  const killError =
    actionData?.intent === "kill" &&
    actionData.ok === false &&
    selectedSandboxId &&
    actionData.sandboxId === selectedSandboxId
      ? actionData.message
      : null;

  const commandDisabled = !selectedSandbox || selectedSandbox.status !== "running";

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Environments", to: "/backoffice/environments" },
          { label: "CF Sandbox" },
        ]}
        eyebrow="Environment"
        title="CF Sandbox workspace."
        description="Start isolated sandboxes, inspect health, and run commands against active instances."
        actions={
          <Link
            to="/backoffice/environments"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to environments
          </Link>
        }
      />

      <section className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              Active sandboxes
            </p>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--bo-muted)]">
              {activeInstances.length}
            </span>
          </div>

          <div className="mt-3 space-y-2">
            <Link
              to={toCfSandboxPath({ view: "new" })}
              aria-current={view === "new" ? "page" : undefined}
              className={
                view === "new"
                  ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.14)]"
                  : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
              }
            >
              <p className="text-[10px] uppercase tracking-[0.24em]">New sandbox</p>
              <p className="mt-2 text-sm font-semibold">Create a fresh instance</p>
            </Link>

            {activeInstances.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-xs text-[var(--bo-muted)]">
                No active instances yet.
              </div>
            ) : (
              activeInstances.map((instance) => {
                const isSelected =
                  view === "detail" && selectedSandboxId && selectedSandboxId === instance.id;
                return (
                  <Link
                    key={instance.id}
                    to={toCfSandboxPath({ sandboxId: instance.id })}
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
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${STATUS_CLASSES[instance.status]}`}
                      >
                        {STATUS_LABELS[instance.status]}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                      Live status from sandbox runtime
                    </p>
                  </Link>
                );
              })
            )}
          </div>
        </aside>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]">
          {loadError ? (
            <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
              Failed loading sandbox registry: {loadError}
            </div>
          ) : view === "new" ? (
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
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Sandbox not found
              </p>
              <p className="text-sm text-[var(--bo-muted)]">
                The selected sandbox is no longer available in the registry.
              </p>
              <Link
                to={toCfSandboxPath({ view: "new" })}
                className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
              >
                Create new sandbox
              </Link>
            </div>
          )}
        </section>
      </section>
    </div>
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
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
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
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
              Sandbox id (optional)
            </span>
            <input
              name="id"
              defaultValue={values.id}
              placeholder="auto-generated"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
              Leave blank to auto-generate. This id is used to reference and reopen the sandbox. IDs
              are always normalized automatically.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
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
            <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
              Idle timeout before the sandbox can sleep. Accepts duration text like `15m` or a
              seconds value like `900`.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
              Startup command
            </span>
            <input
              name="startupCommand"
              defaultValue={values.startupCommand}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
              Command executed immediately after provisioning. If it fails, sandbox startup is
              marked as failed.
            </span>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
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
            <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
              Maximum time allowed for the startup command before it times out.
            </span>
          </label>
        </div>

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
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
              <span className="text-xs uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
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
            className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
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
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
            Sandbox details
          </p>
          <h2 className="mt-2 truncate font-mono text-xl font-semibold text-[var(--bo-fg)] md:text-2xl">
            {sandbox.id}
          </h2>
          <p className="mt-2 text-xs text-[var(--bo-muted)]">
            Inspect runtime status and run commands against this instance.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${STATUS_CLASSES[sandbox.status]}`}
        >
          {STATUS_LABELS[sandbox.status]}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <DetailItem
          label="Runtime status"
          value={STATUS_LABELS[sandbox.status]}
          description="Resolved from the current sandbox runtime state."
        />
        <DetailItem
          label="Registry record"
          value="Tracked by id"
          description="Registry stores only sandbox ids and reads live status on request."
        />
      </div>

      <div className="space-y-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
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
              <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
                Optional command timeout. Leave blank for runtime default.
              </span>
            </label>

            <button
              type="submit"
              disabled={commandDisabled || isExecuting}
              className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
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
        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">Output</p>
        <p className="text-xs text-[var(--bo-muted)]">
          Displays the most recent command result for the currently selected sandbox.
        </p>
        {commandRun ? (
          <CommandOutput command={commandRun.command} result={commandRun.result} />
        ) : (
          <p className="text-sm text-[var(--bo-muted)]">Run a command to view stdout and stderr.</p>
        )}
      </div>

      <Form method="post" className="space-y-2 border border-red-200 bg-red-50 p-3">
        <input type="hidden" name="intent" value="kill" />
        <input type="hidden" name="sandboxId" value={sandbox.id} />
        <button
          type="submit"
          disabled={isKilling}
          className="inline-flex border border-red-300 bg-red-100 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-red-700 transition-colors hover:border-red-400 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isKilling ? "Stopping..." : "Kill sandbox"}
        </button>
        <p className="text-xs text-red-700">
          Destroys the sandbox instance and removes it from the tracked list.
        </p>
        {killError ? <p className="text-sm text-red-700">{killError}</p> : null}
      </Form>
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

function DetailItem({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">{label}</p>
      <p className="mt-2 text-sm font-medium text-[var(--bo-fg)]">{value || "—"}</p>
      <p className="mt-1 text-xs text-[var(--bo-muted)]">{description}</p>
    </div>
  );
}

function LogBlock({ label, value }: { label: "stdout" | "stderr"; value?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">{label}</p>
      <pre className="backoffice-scroll max-h-56 overflow-auto border border-[color:var(--bo-border)] bg-[rgba(var(--bo-grid),0.08)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)]">
        {value?.trim() ? value : "(empty)"}
      </pre>
    </div>
  );
}

function toCfSandboxPath(options: { view?: CfSandboxView; sandboxId?: string }) {
  const params = new URLSearchParams();
  if (options.view === "new") {
    params.set("view", "new");
  } else if (options.sandboxId) {
    params.set("sandbox", options.sandboxId);
  }

  const query = params.toString();
  return query
    ? `/backoffice/environments/cf-sandbox?${query}`
    : "/backoffice/environments/cf-sandbox";
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

async function resolveActiveOrganizationId(
  request: Request,
  context: Route.LoaderArgs["context"] | Route.ActionArgs["context"],
): Promise<string | null> {
  const me = await getAuthMe(request, context);
  return me?.activeOrganization?.organization.id ?? null;
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
