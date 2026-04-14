import { Activity, Bot, Database, Mail, Route as RouteIcon, Send, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { BackofficeScreenshotFigure } from "@/components/backoffice-screenshot-figure";
import { TabbedCodeFigure, type TabbedCodeFigureTab } from "@/components/essay-components";
import {
  FragmentActionLink,
  FragmentEyebrow,
  FragmentHero,
  FragmentPageShell,
  FragmentPanel,
  FragmentSection,
} from "@/components/fragment-editorial";
import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { ResendDataFlow } from "@/components/resend-data-flow";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function meta() {
  return [
    { title: "Resend Fragment" },
    {
      name: "description",
      content:
        "Send, receive, thread, and query email with typed APIs and a database-backed canonical message store.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

type FlowStep = {
  title: string;
  description: string;
};

type SetupStep = {
  title: string;
  description: string;
  lang: "ts" | "tsx";
  code: string;
};

const features: Feature[] = [
  {
    title: "Send email reliably",
    description: "Trigger transactional email without blocking your synchronous request flow.",
    icon: <Send className="size-5" />,
  },
  {
    title: "Webhooks handled",
    description:
      "Signature verification, retries, and status syncing are packaged into the fragment.",
    icon: <Activity className="size-5" />,
  },
  {
    title: "Inbound email",
    description: "Receive inbound mail and persist the actual message body and metadata locally.",
    icon: <Mail className="size-5" />,
  },
  {
    title: "Automatic threading",
    description:
      "Resolve replies into thread timelines using reply tokens, headers, and subject heuristics.",
    icon: <RouteIcon className="size-5" />,
  },
  {
    title: "Frontend hooks",
    description: "Use typed hooks for domains, emails, threads, messages, and replies in your UI.",
    icon: <Workflow className="size-5" />,
  },
  {
    title: "Canonical local store",
    description:
      "Keep durable email and thread state in your own database instead of depending on provider retention.",
    icon: <Database className="size-5" />,
  },
];

const flow: FlowStep[] = [
  {
    title: "1. Resend receives an inbound email",
    description: "Resend posts an inbound webhook to the mounted webhook route.",
  },
  {
    title: "2. The fragment stores the inbound email in your database",
    description:
      "The fragment stores the inbound email in your database, then calls the onEmailReceived callback.",
  },
  {
    title: "3. Query from your frontend",
    description:
      "The frontend reads threads, messages, and delivery state through typed client hooks against your own backend.",
  },
];

const setupSteps: SetupStep[] = [
  {
    title: "1. Create the fragment server",
    description: "Configure credentials, defaults, and callbacks once.",
    lang: "ts",
    code: `import { createResendFragment } from "@fragno-dev/resend-fragment";
import { databaseAdapter } from "@/lib/db";

export const resendFragment = createResendFragment(
  {
    apiKey: process.env.RESEND_API_KEY!,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    defaultFrom: "Support <support@example.com>",
    onEmailReceived: async ({ threadId }) => {
      console.log("Inbound →", threadId);
    },
  },
  {
    databaseAdapter,
    mountRoute: "/api/resend",
  },
);`,
  },
  {
    title: "2. Mount the routes",
    description:
      "Expose the fragment through your framework once, then let the client call your app.",
    lang: "ts",
    code: `import { resendFragment } from "@/lib/resend";

export const handlers = resendFragment.handlersFor("react-router");

export const action = handlers.action;
export const loader = handlers.loader;`,
  },
  {
    title: "3. Create the client",
    description: "Point the client at the same mount route and get typed hooks back.",
    lang: "ts",
    code: `import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";

export const resendClient = createResendFragmentClient({
  mountRoute: "/api/resend",
});`,
  },
  {
    title: "4. Build with thread hooks",
    description:
      "Use local thread state instead of orchestrating raw webhook and provider APIs yourself.",
    lang: "tsx",
    code: `function SupportInbox({ threadId }: { threadId: string }) {
  const { data: threads } = resendClient.useThreads();
  const { data: messages } = resendClient.useThreadMessages({
    path: { threadId },
  });
  const { mutate: reply } = resendClient.useReplyToThread();

  return (
    <ThreadLayout threads={threads?.threads ?? []}>
      <MessageTimeline messages={messages?.messages ?? []} />
      <ReplyBox
        onSend={(text) =>
          reply({
            path: { threadId },
            body: { text },
          })
        }
      />
    </ThreadLayout>
  );
}`,
  },
];

const skillInstallCommand = "npx skills add https://github.com/rejot-dev/fragno --skill fragno";

const routeSurface = `// Used by Resend to post inbound webhooks
POST /webhook

// Query domain readiness from Resend
GET  /domains
GET  /domains/:domainId

// Retrieve inbound and outbound emails from your own database
GET  /emails
GET  /emails/:emailId
POST /emails

// Retrieve inbound emails directly from Resend (as long as retention allows)
GET  /received-emails
GET  /received-emails/:emailId

// Query threads and messages from your own database
GET  /threads
POST /threads
GET  /threads/:threadId
GET  /threads/:threadId/messages
POST /threads/:threadId/reply`;

const blueprintTabs: TabbedCodeFigureTab[] = [
  {
    id: "create-server",
    label: "01_INITIALIZATION",
    color: "secondary",
    headline: "01_INITIALIZATION",
    description:
      "Configure credentials, defaults, and callbacks once. Then start using it from your frontend immediately (see next tab).",
    snippets: [
      {
        label: "01_INITIALIZATION",
        code: setupSteps[0]!.code,
        lang: setupSteps[0]!.lang,
      },
    ],
  },
  {
    id: "thread-hooks",
    label: "02_USAGE",
    color: "primary",
    headline: "02_USAGE",
    description:
      "Use the library's thread hooks to build your UI. All logic is handled for you in the background.",
    snippets: [
      {
        label: "02_USAGE",
        code: setupSteps[3]!.code,
        lang: setupSteps[3]!.lang,
      },
    ],
  },
];

export default function ResendPage() {
  return (
    <FragmentPageShell>
      <FragmentSubnav current="resend" />

      <FragmentHero
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">
            06 // Resend Email
          </FragmentEyebrow>
        }
        title={<>The only library that receives email</>}
        description={
          <>
            Send mail, receive inbound replies, persist thread history, and query it fully typed.
            This full-stack library turns the Resend SDK up 10 notches.
          </>
        }
        aside={
          <div className="mx-auto w-full max-w-2xl pt-2 lg:mx-0 lg:max-w-none lg:pt-0">
            <FragmentPanel className="space-y-4">
              <Tabs defaultValue="agent-skill" className="gap-4">
                <TabsList className="grid h-auto w-full grid-cols-2 gap-0 rounded-none border-0 bg-[var(--editorial-surface-low)] p-1 shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]">
                  <TabsTrigger
                    value="agent-skill"
                    className="h-10 gap-2 rounded-none border-0 bg-transparent px-3 py-2 text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase shadow-none transition-colors data-[state=active]:bg-[color-mix(in_srgb,var(--editorial-surface)_82%,transparent)] data-[state=active]:text-[var(--editorial-ink)] data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)]"
                  >
                    <Bot className="size-4" />
                    Agent skill
                  </TabsTrigger>
                  <TabsTrigger
                    value="install"
                    className="h-10 gap-2 rounded-none border-0 bg-transparent px-3 py-2 text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase shadow-none transition-colors data-[state=active]:bg-[color-mix(in_srgb,var(--editorial-surface)_82%,transparent)] data-[state=active]:text-[var(--editorial-ink)] data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)]"
                  >
                    Install
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="agent-skill" className="space-y-4 pt-1">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    The Fragno skill will guide your agent through the installation process:
                  </p>
                  <FragnoCodeBlock
                    lang="bash"
                    code={skillInstallCommand}
                    allowCopy
                    syntaxTheme="editorial-triad"
                    className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
                  />
                  <div className="mt-4 space-y-2">
                    <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                      Ask your agent
                    </p>
                    <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                      Tell your agent to "Integrate the Resend fragment into my application"
                    </p>
                  </div>
                </TabsContent>

                <TabsContent value="install" className="space-y-4 pt-1">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Install the fragment and the database package, then mount it once in your app.
                  </p>
                  <FragnoCodeBlock
                    lang="bash"
                    code="npm install @fragno-dev/resend-fragment @fragno-dev/db"
                    allowCopy
                    syntaxTheme="editorial-triad"
                    className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
                  />
                  <div className="mt-4 space-y-2">
                    <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                      See quickstart for manual installation.
                    </p>
                  </div>
                </TabsContent>
              </Tabs>
            </FragmentPanel>
          </div>
        }
      >
        <div className="flex flex-wrap gap-3 pt-2">
          <FragmentActionLink to="/docs/resend/quickstart">Quickstart</FragmentActionLink>
          <FragmentActionLink variant="secondary" to="/docs/resend/using">
            Using the library
          </FragmentActionLink>
          <FragmentActionLink variant="secondary" to="/fragments/resend/essay">
            Read essay
          </FragmentActionLink>
        </div>
      </FragmentHero>

      <FragmentSection eyebrow={<FragmentEyebrow>The Code</FragmentEyebrow>}>
        <TabbedCodeFigure
          ariaLabel="Resend fragment blueprint"
          defaultTabId="create-server"
          fullWidth
          tabs={blueprintTabs}
        />
      </FragmentSection>

      <FragmentSection eyebrow={<FragmentEyebrow>Features</FragmentEyebrow>}>
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
        eyebrow={<FragmentEyebrow>Flow</FragmentEyebrow>}
        description={
          <>
            The library integrates across every part of your stack: frontend, backend, and database.
            It handles communication with Resend for you. Instead of manually stitching together
            webhooks, retries, and local projections, you mount the fragment and simply use our
            hooks.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[0.92fr_1.08fr]">
          <FragmentPanel className="space-y-4">
            <div className="flex items-center gap-3 text-[var(--editorial-muted)]">
              <Activity className="size-5" />
              <h3 className="text-xl font-bold tracking-[-0.03em] text-[var(--editorial-ink)]">
                Inbound flow
              </h3>
            </div>
            <ol className="space-y-4">
              {flow.map((item, index) => (
                <li key={item.title} className="flex gap-4">
                  <div className="flex h-8 w-8 items-center justify-center bg-[var(--editorial-surface-low)] text-sm font-bold text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]">
                    {index + 1}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-[var(--editorial-ink)]">{item.title}</p>
                    <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                      {item.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </FragmentPanel>
          <FragmentPanel>
            <ResendDataFlow />
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Blueprint</FragmentEyebrow>}
        description={
          <>
            The setup is deliberately small: create the server, mount the handlers, create a client,
            then build UI against typed thread and message hooks.
          </>
        }
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

      <FragmentSection
        eyebrow={<FragmentEyebrow>Interface</FragmentEyebrow>}
        description={
          <>
            The library exposes a number of routes within your application. Some go to your own
            database, others go to Resend. The threading model is built into the library, so you can
            simply use the hooks to build your UI.
          </>
        }
      >
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-8">
          <FragmentPanel className="min-w-0 flex-1 space-y-3">
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

          <div className="min-w-0 flex-1">
            <BackofficeScreenshotFigure
              screenshotUrl={{
                light: "/backoffice-resend-light.jpg",
                dark: "/backoffice-resend-dark.jpg",
              }}
              caption="Fig. The Resend library integrated into our “Claw-like” backoffice."
            />
          </div>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Next steps</FragmentEyebrow>}
        title={<>Ship email quickly, so you can focus on your business logic</>}
        description={
          <>
            Start with the quickstart, then move to the usage guide when you want to build inboxes,
            thread UIs, or callback-driven workflows. Or read the essay to see how and why we built
            this library.
          </>
        }
      >
        <div className="flex flex-wrap gap-3 pt-2">
          <FragmentActionLink to="/docs/resend/quickstart">Read the quickstart</FragmentActionLink>
          <FragmentActionLink variant="secondary" to="/docs/resend/using">
            Learn the runtime surface
          </FragmentActionLink>
          <FragmentActionLink variant="secondary" to="/fragments/resend/essay">
            Read the essay
          </FragmentActionLink>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
