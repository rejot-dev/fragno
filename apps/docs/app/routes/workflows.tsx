import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, Activity, Route as RouteIcon, RotateCcw, Terminal, Timer } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { FragmentSubnav } from "@/components/fragment-subnav";

export function meta() {
  return [
    { title: "Workflows Fragment" },
    {
      name: "description",
      content: "Durable workflows with steps, events, retries, and database-backed state.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

type Step = {
  title: string;
  description: string;
  lang: "bash" | "ts";
  code: string;
};

type WorkflowExample = {
  id: string;
  title: string;
  summary: string;
  code: string;
};

const features: Feature[] = [
  {
    title: "Durable steps + retries",
    description: "Run long-lived workflows with durable state stored in your database.",
    icon: <RotateCcw className="size-5" />,
  },
  {
    title: "Timers + event waits",
    description: "Pause for events, schedule timers, and resume exactly where you left off.",
    icon: <Activity className="size-5" />,
  },
  {
    title: "HTTP API + CLI",
    description: "Create, inspect, and control workflows via HTTP routes and the fragno-wf CLI.",
    icon: <RouteIcon className="size-5" />,
  },
];

const setupSteps: Step[] = [
  {
    title: "1. Install",
    description: "Install the workflows fragment and database package.",
    lang: "bash",
    code: "npm install @fragno-dev/workflows @fragno-dev/db",
  },
  {
    title: "2. Define a workflow",
    description: "Create a workflow with events, timers, and durable steps.",
    lang: "ts",
    code: `import { defineWorkflow } from "@fragno-dev/workflows";

export const ApprovalWorkflow = defineWorkflow(
  { name: "approval-workflow" },
  async (event, step) => {
    const approval = await step.waitForEvent("approval", {
      type: "approval",
      timeout: "15 min",
    });

    await step.sleep("cooldown", "2 s");

    return { approved: approval.payload?.approved };
  },
);

export const workflows = { approval: ApprovalWorkflow } as const;`,
  },
  {
    title: "3. Create the fragment server",
    description: "Instantiate the fragment and attach the workflow runner.",
    lang: "ts",
    code: `import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { createWorkflowsRunner, workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

const fragment = instantiate(workflowsFragmentDefinition)
  .withConfig({ workflows, runtime: defaultFragnoRuntime, enableRunnerTick: true })
  .withRoutes([workflowsRoutesFactory])
  .withOptions({ databaseAdapter })
  .build();

const runner = createWorkflowsRunner({ fragment, workflows, runtime: defaultFragnoRuntime });`,
  },
];

const workflowExamples: WorkflowExample[] = [
  {
    id: "retry",
    title: "Retry workflow",
    summary: "Retry a failed step with constant backoff.",
    code: `const RetryWorkflow = defineWorkflow(
  { name: "retry-workflow" },
  async (_event, step) => {
    return await step.do(
      "retry-step",
      { retries: { limit: 1, delay: "40 ms", backoff: "constant" } },
      () => {
        if (Math.random() < 0.5) {
          throw new Error("RETRY_ME");
        }
        return { ok: true };
      },
    );
  },
);`,
  },
  {
    id: "parent-child",
    title: "Parent + child workflows",
    summary: "Spawn child workflows from a parent run.",
    code: `const ChildWorkflow = defineWorkflow(
  { name: "child-workflow" },
  async (event, step) => {
    return await step.do("child-run", () => ({ parentId: event.payload.parentId }));
  },
);

const ParentWorkflow = defineWorkflow(
  { name: "parent-workflow" },
  async (event, step, context) => {
    return await step.do("spawn-child", async () => {
      const child = await context.workflows["child"].create({
        id: \`child-\${event.instanceId}\`,
        params: { parentId: event.instanceId },
      });

      return { childId: child.id };
    });
  },
);`,
  },
  {
    id: "pause-boundary",
    title: "Pause boundary",
    summary: "Pause a workflow mid-step and resume later.",
    code: `const PauseBoundaryWorkflow = defineWorkflow(
  { name: "pause-boundary-workflow" },
  async (_event, step) => {
    await step.do("pause-boundary", () => new Promise((resolve) => {
      // Resume from an external signal
      resolve({ ok: true });
    }));

    return await step.do("after-pause", () => ({ ok: true }));
  },
);`,
  },
  {
    id: "scheduled",
    title: "Scheduled workflow",
    summary: "Sleep until a scheduled time, then continue.",
    code: `const ScheduledWorkflow = defineWorkflow(
  { name: "scheduled-workflow" },
  async (_event, step) => {
    await step.sleep("scheduled-sleep", "10 minutes");
    return { ok: true };
  },
);`,
  },
];

const cliSnippet = `fragno-wf workflows list -b https://host.example.com/api/workflows

fragno-wf instances create -b https://host.example.com/api/workflows -w approvals \\
  --params '{"requestId":"req_1","amount":125}'

fragno-wf instances send-event -b https://host.example.com/api/workflows -w approvals \\
  -i inst_123 -t approval --payload '{"approved":true}'`;

const usageSnippet = `const baseUrl = "/api/workflows";

await fetch(\`\${baseUrl}/workflows/approval/instances\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ requestId: "req_123", amount: 200 }),
});

await fetch(\`\${baseUrl}/workflows/approval/instances/inst_123/events\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "approval", approved: true }),
});`;

const useCases = [
  {
    title: "Approval chains",
    description: "Route approvals through humans or systems with auditable history.",
  },
  {
    title: "Background orchestration",
    description: "Coordinate retries, timers, and async jobs without glue code.",
  },
  {
    title: "Customer onboarding",
    description: "Guide setup steps, wait for external events, then continue automatically.",
  },
];

export default function WorkflowsPage() {
  const [activeExample, setActiveExample] = useState(workflowExamples[0].id);
  const selectedExample =
    workflowExamples.find((example) => example.id === activeExample) ?? workflowExamples[0];

  return (
    <main className="relative min-h-screen">
      <div className="mx-auto max-w-7xl space-y-14 px-4 py-16 md:px-8">
        <FragmentSubnav current="workflows" />
        <section className="space-y-5 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
            Durable Workflows
          </h1>
          <p className="text-fd-muted-foreground mx-auto max-w-2xl text-lg md:text-xl">
            Define long-running processes with steps, timers, events, and retries.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
            <Link
              to="/docs/workflows"
              className="rounded-lg bg-amber-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-amber-700"
            >
              Workflows Docs
            </Link>
          </div>
          <div className="mx-auto max-w-xl space-y-2 pt-4 text-left">
            <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
              Install
            </p>
            <FragnoCodeBlock
              lang="bash"
              code="npm install @fragno-dev/workflows @fragno-dev/db"
              allowCopy
              className="rounded-xl"
            />
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/30 text-amber-600 dark:text-amber-300">
                  {feature.icon}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {feature.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/30 text-amber-600 dark:text-amber-300">
              <Timer className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Setup blueprint
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                Define workflows, wire the fragment, and start processing.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-6">
              {setupSteps.map((step) => (
                <div
                  key={step.title}
                  className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
                >
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {step.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{step.description}</p>
                  <div className="mt-4">
                    <FragnoCodeBlock
                      lang={step.lang}
                      code={step.code}
                      allowCopy
                      className="rounded-xl"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Trigger runs
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Use the HTTP API to create instances and send events.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock lang="ts" code={usageSnippet} allowCopy className="rounded-xl" />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Next steps</h3>
                <p className="text-fd-muted-foreground mt-2 text-sm">
                  Explore the HTTP surface and runner/dispatcher options.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <Link
                    to="/docs/workflows/routes"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                  >
                    API routes reference
                    <ArrowRight className="size-4" />
                  </Link>
                  <Link
                    to="/docs/workflows/runner-dispatcher"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                  >
                    Runner + dispatcher
                    <ArrowRight className="size-4" />
                  </Link>
                  <Link
                    to="/docs/workflows/debugging"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                  >
                    Debugging workflows
                    <ArrowRight className="size-4" />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/30 text-amber-600 dark:text-amber-300">
              <RotateCcw className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Workflow gallery
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                Real examples inspired by the workflow runner tests.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-3">
              {workflowExamples.map((example) => {
                const isActive = example.id === selectedExample.id;
                return (
                  <button
                    key={example.id}
                    type="button"
                    onClick={() => setActiveExample(example.id)}
                    className={`w-full rounded-2xl border px-4 py-4 text-left transition-all ${
                      isActive
                        ? "border-amber-400/50 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200"
                        : "border-black/5 bg-white text-slate-600 hover:-translate-y-0.5 hover:shadow-md dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-300"
                    }`}
                  >
                    <p className="text-sm font-semibold uppercase tracking-wide">{example.title}</p>
                    <p className="mt-1 text-sm opacity-80">{example.summary}</p>
                  </button>
                );
              })}
            </div>
            <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                {selectedExample.title}
              </h3>
              <p className="text-fd-muted-foreground mt-1 text-sm">{selectedExample.summary}</p>
              <div className="mt-4">
                <FragnoCodeBlock
                  lang="ts"
                  code={selectedExample.code}
                  allowCopy
                  className="rounded-xl"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/30 text-amber-600 dark:text-amber-300">
              <Terminal className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">CLI control</h2>
              <p className="text-fd-muted-foreground text-sm">
                Inspect workflows and send events without building custom dashboards.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <FragnoCodeBlock lang="bash" code={cliSnippet} allowCopy className="rounded-xl" />
            <div className="mt-4 flex flex-col gap-2">
              <Link
                to="/docs/workflows/cli"
                className="inline-flex items-center gap-2 text-sm font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
              >
                Full CLI reference
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Use cases</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {useCases.map((useCase) => (
              <div
                key={useCase.title}
                className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
              >
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {useCase.title}
                </h3>
                <p className="text-fd-muted-foreground mt-2 text-sm">{useCase.description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
