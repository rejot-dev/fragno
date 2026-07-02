import { Activity, Database, Route as RouteIcon, RotateCcw, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import {
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
    { title: "Pi Harness" },
    {
      name: "description",
      content:
        "Build durable AI agents with workflow-backed sessions, robust tool execution, and typed clients.",
    },
  ];
}

type Feature = { title: string; description: string; icon: ReactNode };

const features: Feature[] = [
  {
    title: "Durable sessions",
    description: "Every turn runs through workflows, so agent state survives retries and restarts.",
    icon: <Workflow className="size-5" />,
  },
  {
    title: "Tool execution",
    description:
      "Agent turns can invoke registered tools with structured messages and traceable results.",
    icon: <RotateCcw className="size-5" />,
  },
  {
    title: "Typed session APIs",
    description: "Create sessions, inspect runs, and send messages from framework-native clients.",
    icon: <Database className="size-5" />,
  },
];

const routeSurface = `POST /workflows/:workflowName/sessions
GET  /workflows/:workflowName/sessions
GET  /workflows/:workflowName/sessions/:sessionId
GET  /workflows/:workflowName/sessions/:sessionId/events
POST /workflows/:workflowName/sessions/:sessionId/command`;

const serverSnippet = `import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const interactiveChat = createInteractiveChatWorkflow({
  harnesses: {
    support: {
      env,
      model,
      systemPrompt: "You are a helpful support agent.",
      tools: [searchTool],
    },
  },
});

const piConfig = { workflows: [interactiveChat] };
const workflows = createPiWorkflows(piConfig);

const workflowsFragment = createWorkflowsFragment(
  { workflows, runtime: defaultFragnoRuntime },
  { databaseAdapter, mountRoute: "/api/workflows" },
);

export const fragment = createPiHarness(
  piConfig,
  { databaseAdapter, mountRoute: "/api/pi" },
  { workflows: workflowsFragment.services },
);`;

const clientSnippet = `import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";

const pi = createPiFragmentClient({ baseUrl: "/api/pi" });

const createSession = pi.useCreateSession();
const session = pi.useSession({
  path: { workflowName: "interactive-chat-workflow", sessionId },
});`;

const usageSnippet = `const created = await createSession.mutateQuery({
  path: { workflowName: "interactive-chat-workflow" },
  body: { name: "Customer issue", input: { harnessName: "support" } },
});

await session.sendCommand({
  kind: "prompt",
  input: { text: "Summarize the bug report and propose next steps." },
});`;

export default function PiPage() {
  return (
    <FragmentPageShell>
      <FragmentSubnav current="pi" />

      <FragmentHero
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">
            01 // AI agents
          </FragmentEyebrow>
        }
        title={<>The minimal agent runtime</>}
        description={
          <>
            The Pi harness is built on top of the Workflows fragment and Pi's AgentHarness. It
            provides durable session routes while keeping workflow and tool construction owned by
            your application.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Depends on"
              value="Workflows + DB"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Best for"
              value="Embedding agents"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
          </div>
        }
      >
        <div className="max-w-xl space-y-2 pt-2">
          <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
            Install
          </p>
          <FragnoCodeBlock
            lang="bash"
            code="npm install @fragno-dev/pi-harness @fragno-dev/workflows @fragno-dev/db"
            allowCopy
            syntaxTheme="editorial-triad"
            className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
          />
        </div>
      </FragmentHero>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Capabilities</FragmentEyebrow>
        }
      >
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
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Interface</FragmentEyebrow>
        }
        description={
          <>
            Pi keeps the route surface small. The complexity lives in durable execution semantics,
            not in transport sprawl.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-3">
              <RouteIcon className="size-5 text-[var(--editorial-muted)]" />
              <h3 className="text-xl font-bold tracking-[-0.03em]">Route surface</h3>
            </div>
            <FragnoCodeBlock
              lang="bash"
              code={routeSurface}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Why it matters
            </p>
            <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Agent features fail when state and side effects are implicit. Pi makes both explicit:
              sessions are queryable records, tool calls are persisted in execution output, and
              clients consume typed hooks instead of bespoke chat plumbing.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Blueprint</FragmentEyebrow>
        }
        title={<>Define the agent once, then integrate the product around it.</>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Create the server
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={serverSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <div className="space-y-5">
            <FragmentPanel className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                Create a client
              </p>
              <FragnoCodeBlock
                lang="ts"
                code={clientSnippet}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
            <FragmentPanel className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                Use it
              </p>
              <FragnoCodeBlock
                lang="ts"
                code={usageSnippet}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
          </div>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Outcome</FragmentEyebrow>
        }
        title={<>Built to survive real runtime conditions.</>}
      >
        <div className="grid gap-5 md:grid-cols-3">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Workflow className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Long-running turns</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Pause, resume, and recover work without losing context.
            </p>
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <RotateCcw className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Safe side effects</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Replays reuse captured tool results instead of re-running risky actions.
            </p>
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Inspectable state</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Sessions and messages remain queryable, not trapped in ephemeral runtime memory.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
