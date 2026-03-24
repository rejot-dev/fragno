import { Activity, ArrowRight, Route as RouteIcon, RotateCcw, Terminal, Timer } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  FragmentActionLink,
  FragmentEyebrow,
  FragmentHero,
  FragmentMetric,
  FragmentPageShell,
  FragmentPanel,
  FragmentSection,
} from "@/components/fragment-editorial";
import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function meta() {
  return [
    { title: "Workflows Fragment" },
    {
      name: "description",
      content: "Durable workflows with steps, events, retries, and database-backed state.",
    },
  ];
}

type Feature = { title: string; description: string; icon: ReactNode };
type Step = { title: string; description: string; lang: "bash" | "ts"; code: string };
type WorkflowExample = { id: string; title: string; summary: string; code: string };

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
    description: "Instantiate the fragment and start durable hook processing.",
    lang: "ts",
    code: `import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig({ workflows, runtime: defaultFragnoRuntime })
  .withRoutes([workflowsRoutesFactory])
  .withOptions({ databaseAdapter })
  .build();

const dispatcher = createDurableHooksProcessor([fragment], { pollIntervalMs: 2000 });
dispatcher.startPolling();`,
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
    id: "pause-boundary",
    title: "Pause boundary",
    summary: "Pause a workflow mid-step and resume later.",
    code: `const PauseBoundaryWorkflow = defineWorkflow(
  { name: "pause-boundary-workflow" },
  async (_event, step) => {
    await step.do("pause-boundary", () => new Promise((resolve) => {
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

await fetch(\`${"${baseUrl}"}/workflows/approval/instances\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ requestId: "req_123", amount: 200 }),
});

await fetch(\`${"${baseUrl}"}/workflows/approval/instances/inst_123/events\`, {
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
    <FragmentPageShell>
      <FragmentSubnav current="workflows" />

      <FragmentHero
        eyebrow={<FragmentEyebrow>Workflows</FragmentEyebrow>}
        title={<>Durable Workflows</>}
        description={
          <>
            Durable workflows with retries, timers, waits, and resumable state right from your own
            database. Inspired by Cloudflare Workflows, but usable anywhere.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Runtime"
              value="Steps + events + timers"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Best for"
              value="Durable orchestration"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
          </div>
        }
      >
        <div className="flex flex-wrap gap-3 pt-2">
          <FragmentActionLink to="/docs/workflows">Workflows docs</FragmentActionLink>
        </div>
        <div className="max-w-xl space-y-2 pt-3">
          <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
            Install
          </p>
          <FragnoCodeBlock
            lang="bash"
            code="npm install @fragno-dev/workflows @fragno-dev/db"
            allowCopy
            syntaxTheme="editorial-triad"
            className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
          />
        </div>
      </FragmentHero>

      <FragmentSection eyebrow={<FragmentEyebrow>Capabilities</FragmentEyebrow>}>
        <div className="grid gap-5 md:grid-cols-3">
          {features.map((feature) => (
            <FragmentPanel key={feature.title} className="space-y-4">
              <div className="flex items-center gap-3 text-[var(--editorial-muted)]">
                {feature.icon}
                <h3 className="text-xl font-bold tracking-[-0.03em] text-[var(--editorial-ink)]">
                  {feature.title}
                </h3>
              </div>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {feature.description}
              </p>
            </FragmentPanel>
          ))}
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Blueprint</FragmentEyebrow>}
        title={<>Define the workflow, mount the fragment, start the durable processor.</>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {setupSteps.map((step) => (
            <FragmentPanel key={step.title} className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                {step.title}
              </p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {step.description}
              </p>
              <FragnoCodeBlock
                lang={step.lang}
                code={step.code}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
          ))}
        </div>
      </FragmentSection>

      <FragmentSection eyebrow={<FragmentEyebrow>Examples</FragmentEyebrow>}>
        <div className="grid gap-5 lg:grid-cols-[0.46fr_0.54fr]">
          <FragmentPanel className="space-y-3">
            {workflowExamples.map((example) => {
              const isActive = example.id === selectedExample.id;
              return (
                <button
                  key={example.id}
                  type="button"
                  onClick={() => setActiveExample(example.id)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] transition-colors ${isActive ? "bg-[var(--editorial-surface-low)] text-[var(--editorial-ink)]" : "bg-transparent text-[var(--editorial-muted)] hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)]"}`}
                >
                  <div>
                    <p className="text-sm font-bold tracking-[0.12em] uppercase">{example.title}</p>
                    <p className="mt-1 text-sm leading-[1.7]">{example.summary}</p>
                  </div>
                  <ArrowRight className="size-4 shrink-0" />
                </button>
              );
            })}
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              {selectedExample.title}
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={selectedExample.code}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection eyebrow={<FragmentEyebrow>Use it</FragmentEyebrow>}>
        <div className="grid gap-5 lg:grid-cols-2">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2 text-[var(--editorial-muted)]">
              <Terminal className="size-4" />
              <p className="text-sm font-bold tracking-[0.14em] uppercase">CLI</p>
            </div>
            <FragnoCodeBlock
              lang="bash"
              code={cliSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2 text-[var(--editorial-muted)]">
              <Timer className="size-4" />
              <p className="text-sm font-bold tracking-[0.14em] uppercase">HTTP</p>
            </div>
            <FragnoCodeBlock
              lang="ts"
              code={usageSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection eyebrow={<FragmentEyebrow>Use cases</FragmentEyebrow>}>
        <div className="grid gap-5 md:grid-cols-3">
          {useCases.map((useCase) => (
            <FragmentPanel key={useCase.title} className="space-y-3">
              <p className="text-lg font-bold tracking-[-0.03em]">{useCase.title}</p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {useCase.description}
              </p>
            </FragmentPanel>
          ))}
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
