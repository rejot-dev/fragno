import { Activity, Database, Mail, Route as RouteIcon, Send } from "lucide-react";
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
    { title: "Resend Fragment" },
    {
      name: "description",
      content:
        "Send, receive, and thread email with typed APIs and a local canonical message store.",
    },
  ];
}

type Feature = { title: string; description: string; icon: ReactNode };

const features: Feature[] = [
  {
    title: "Outbound + inbound",
    description: "Send mail, ingest webhooks, and track status from one fragment.",
    icon: <Send className="size-5" />,
  },
  {
    title: "Reliable threading",
    description: "Threads read from one canonical local message store for cleaner history.",
    icon: <Mail className="size-5" />,
  },
  {
    title: "Typed email APIs",
    description: "Domains, emails, received mail, threads, and replies all ship with hooks.",
    icon: <Database className="size-5" />,
  },
];

const routeSurface = `POST /webhooks
GET  /domains
GET  /domains/:domainId
GET  /emails
GET  /emails/:emailId
POST /emails
GET  /received-emails
GET  /received-emails/:emailId
GET  /threads
POST /threads
GET  /threads/:threadId
GET  /threads/:threadId/messages
POST /threads/:threadId/reply`;

const serverSnippet = `import { createResendFragment } from "@fragno-dev/resend-fragment";

export const resendFragment = createResendFragment(
  {
    apiKey: process.env.RESEND_API_KEY!,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    defaultFrom: "Support <support@example.com>",
  },
  {
    databaseAdapter,
    mountRoute: "/api/resend",
  },
);`;

const clientSnippet = `import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";

const resend = createResendFragmentClient({ baseUrl: "/api/resend" });

const { data: threads } = resend.useThreads();
const sendEmail = resend.useSendEmail();
const replyToThread = resend.useReplyToThread();`;

const usageSnippet = `await sendEmail.mutate({
  body: {
    from: "Support <support@example.com>",
    to: ["customer@example.com"],
    subject: "Welcome",
    text: "You're in.",
  },
});

await replyToThread.mutate({
  path: { threadId },
  body: { text: "Thanks — we're on it." },
});`;

export default function ResendPage() {
  return (
    <FragmentPageShell>
      <FragmentSubnav current="resend" />

      <FragmentHero
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">02 // Email</FragmentEyebrow>
        }
        title={<>Email, in and out</>}
        description={
          <>
            The Resend fragment gives you a complete email runtime: send mail, ingest webhooks, and
            persist thread history in your own database.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Own the data"
              value="Threads in your DB"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Best for"
              value="Support + onboarding"
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
            code="npm install @fragno-dev/resend-fragment @fragno-dev/db"
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
            The route surface stays broad enough for real thread workflows while remaining coherent.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[0.72fr_1.28fr]">
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
              Support, approvals, onboarding, and notifications become more reliable when your app
              can query them as first-class product data. Resend encapsulates transport concerns and
              leaves you with typed hooks over durable thread history.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Blueprint</FragmentEyebrow>
        }
        title={<>Mount once, then build around owned message history.</>}
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
        title={<>Email becomes queryable application state.</>}
      >
        <div className="grid gap-5 md:grid-cols-3">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Send className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Send from your app</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Trigger product mail without hand-rolling provider code.
            </p>
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Keep thread history</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              See the full conversation in one local timeline.
            </p>
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">React to updates</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Use inbound events to power automation and human workflows alike.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
