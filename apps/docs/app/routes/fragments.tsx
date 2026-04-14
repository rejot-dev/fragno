import { ArrowRight, Package } from "lucide-react";
import { Link } from "react-router";

import {
  FragmentActionLink,
  FragmentEyebrow,
  FragmentHero,
  FragmentPageShell,
  FragmentPanel,
} from "@/components/fragment-editorial";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function meta() {
  return [
    { title: "Fragno Fragments" },
    {
      name: "description",
      content:
        "Explore Fragno first-party fragments for billing, forms, workflows, AI, email, GitHub, messaging, uploads, and more.",
    },
  ];
}

type FragmentStatus = "available" | "coming";

type FragmentCard = {
  id:
    | "stripe"
    | "forms"
    | "workflows"
    | "upload"
    | "auth"
    | "telegram"
    | "pi"
    | "resend"
    | "github";
  name: string;
  category: string;
  description: string;
  status: FragmentStatus;
  href: string;
  docsHref?: string;
  install?: string;
  highlights?: string[];
  accentText: string;
  accentDot: string;
  accentPanel: string;
};

const fragments: FragmentCard[] = [
  {
    id: "stripe",
    name: "Stripe Billing",
    category: "Billing",
    description: "Subscriptions, checkout, webhooks, and billing portal flows in one fragment.",
    status: "available",
    href: "/fragments/stripe",
    docsHref: "/docs/stripe",
    install: "npm install @fragno-dev/stripe @fragno-dev/db",
    highlights: [
      "Checkout + upgrade + cancel flows",
      "Webhook handling + subscription sync",
      "Database-backed subscription state",
    ],
    accentText: "text-violet-700 dark:text-violet-300",
    accentDot: "bg-violet-500/80 dark:bg-violet-400/80",
    accentPanel: "border-l-2 border-l-violet-400/70",
  },
  {
    id: "telegram",
    name: "Telegram Bots",
    category: "Messaging",
    description: "Durable webhooks, command registry, and chat history for Telegram bots.",
    status: "available",
    href: "/fragments/telegram",
    docsHref: "/docs/telegram",
    install: "npm install @fragno-dev/telegram-fragment @fragno-dev/db",
    highlights: [
      "Command registry + per-chat bindings",
      "Chat, member, and message persistence",
      "Typed hooks for sending messages",
    ],
    accentText: "text-cyan-700 dark:text-cyan-300",
    accentDot: "bg-cyan-500/80 dark:bg-cyan-400/80",
    accentPanel: "border-l-2 border-l-cyan-400/70",
  },
  {
    id: "forms",
    name: "Forms",
    category: "Forms",
    description: "Create forms, collect responses, and render with JSON Schema + JSON Forms.",
    status: "available",
    href: "/fragments/forms",
    docsHref: "/docs/forms",
    install: "npm install @fragno-dev/forms @fragno-dev/db",
    highlights: [
      "Open standards-based schemas",
      "Form builder and admin APIs",
      "Typed hooks for public forms",
    ],
    accentText: "text-sky-700 dark:text-sky-300",
    accentDot: "bg-sky-500/80 dark:bg-sky-400/80",
    accentPanel: "border-l-2 border-l-sky-400/70",
  },
  {
    id: "workflows",
    name: "Workflows",
    category: "Automation",
    description: "Durable workflows with steps, timers, events, and retries.",
    status: "available",
    href: "/fragments/workflows",
    docsHref: "/docs/workflows",
    install: "npm install @fragno-dev/workflows @fragno-dev/db",
    highlights: [
      "Durable state stored in your database",
      "HTTP API for instances + history",
      "Runner + dispatcher architecture",
    ],
    accentText: "text-amber-700 dark:text-amber-300",
    accentDot: "bg-amber-500/80 dark:bg-amber-400/80",
    accentPanel: "border-l-2 border-l-amber-400/70",
  },
  {
    id: "pi",
    name: "Pi",
    category: "AI Agents",
    description: "Workflow-backed AI agents with durable sessions, tool replay, and typed clients.",
    status: "available",
    href: "/fragments/pi",
    install: "npm install @fragno-dev/pi-fragment @fragno-dev/workflows @fragno-dev/db",
    highlights: [
      "Durable agent sessions",
      "Deterministic tool replay",
      "Typed session + message APIs",
    ],
    accentText: "text-fuchsia-700 dark:text-fuchsia-300",
    accentDot: "bg-fuchsia-500/80 dark:bg-fuchsia-400/80",
    accentPanel: "border-l-2 border-l-fuchsia-400/70",
  },
  {
    id: "resend",
    name: "Resend",
    category: "Email",
    description: "Send, receive, and thread email with one local source of truth.",
    status: "available",
    href: "/fragments/resend",
    docsHref: "/docs/resend",
    install: "npm install @fragno-dev/resend-fragment @fragno-dev/db",
    highlights: [
      "Send mail via fully typed hooks and track delivery status.",
      "Receive email and store their contents in your database.",
      "Threads read from one canonical local message store for cleaner history.",
    ],
    accentText: "text-rose-700 dark:text-rose-300",
    accentDot: "bg-rose-500/80 dark:bg-rose-400/80",
    accentPanel: "border-l-2 border-l-rose-400/70",
  },
  {
    id: "github",
    name: "GitHub",
    category: "Developer Tools",
    description: "GitHub App integration for installs, repos, webhooks, and pull requests.",
    status: "available",
    href: "/fragments/github",
    install: "npm install @fragno-dev/github-app-fragment @fragno-dev/db",
    highlights: [
      "App auth handled for you",
      "Webhook-driven install + repo sync",
      "Pull request actions via typed routes",
    ],
    accentText: "text-slate-700 dark:text-slate-200",
    accentDot: "bg-slate-500/80 dark:bg-slate-300/80",
    accentPanel: "border-l-2 border-l-slate-400/70",
  },
  {
    id: "upload",
    name: "Uploads",
    category: "File Uploads",
    description: "Direct + proxy uploads with storage adapters and progress tracking.",
    status: "available",
    href: "/fragments/upload",
    docsHref: "/docs/upload/overview",
    install: "npm install @fragno-dev/upload",
    highlights: [
      "File + upload data model",
      "S3/R2 + filesystem adapters",
      "Client helpers with progress",
    ],
    accentText: "text-cyan-700 dark:text-cyan-300",
    accentDot: "bg-cyan-500/80 dark:bg-cyan-400/80",
    accentPanel: "border-l-2 border-l-cyan-400/70",
  },
  {
    id: "auth",
    name: "Authentication",
    category: "Auth",
    description: "Authentication fragment for users, sessions, organizations, and roles.",
    status: "available",
    href: "/fragments/auth",
    docsHref: "/docs/auth",
    install: "npm install @fragno-dev/auth",
    accentText: "text-emerald-700 dark:text-emerald-300",
    accentDot: "bg-emerald-500/80 dark:bg-emerald-400/80",
    accentPanel: "border-l-2 border-l-emerald-400/70",
  },
];

export default function FragmentsPage() {
  return (
    <FragmentPageShell>
      <FragmentHero
        eyebrow={
          <FragmentEyebrow>
            <span className="inline-flex items-center gap-2">
              <Package className="size-4" />
              Fragment catalogue
            </span>
          </FragmentEyebrow>
        }
        title={<>First-party Fragments</>}
        description={
          <>
            Fragno fragments bundle routes, hooks, and optional data models into one authored slice.
            Use these libraries to get up and running quickly!
          </>
        }
        aside={undefined}
      >
        <div className="flex flex-wrap gap-3 pt-2">
          <FragmentActionLink to="/docs/fragno/user-quick-start">
            Start integrating
          </FragmentActionLink>
          <FragmentActionLink
            to="/docs/fragno/for-library-authors/getting-started"
            variant="secondary"
          >
            Build your own fragment
          </FragmentActionLink>
        </div>
      </FragmentHero>

      <div className="grid gap-5 md:grid-cols-2">
        {fragments.map((fragment, index) => (
          <FragmentPanel key={fragment.id} className={`space-y-5 ${fragment.accentPanel}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <p
                  className={`text-sm font-bold tracking-[0.16em] uppercase ${fragment.accentText}`}
                >
                  {String(index + 1).padStart(2, "0")} // {fragment.category}
                </p>
                <h2 className="text-3xl leading-none font-bold tracking-[-0.04em]">
                  {fragment.name}
                </h2>
              </div>
            </div>

            <p className="max-w-xl text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              {fragment.description}
            </p>

            {fragment.highlights && fragment.highlights.length > 0 ? (
              <ul className="grid gap-2 text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {fragment.highlights.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span
                      aria-hidden
                      className={`mt-2 inline-flex h-1.5 w-1.5 rounded-full ${fragment.accentDot}`}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {fragment.install ? (
              <div className="space-y-2">
                <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                  Install
                </p>
                <FragnoCodeBlock
                  lang="bash"
                  code={fragment.install}
                  allowCopy
                  syntaxTheme="editorial-triad"
                  className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
                />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Link
                to={fragment.href}
                className="inline-flex items-center gap-2 bg-[var(--editorial-ink)] px-4 py-2 text-sm font-bold tracking-[0.12em] text-[var(--editorial-paper)] uppercase transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-ink)_88%,black)]"
              >
                Overview
                <ArrowRight className="size-4" />
              </Link>
              {fragment.docsHref ? (
                <Link
                  to={fragment.docsHref}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold tracking-[0.12em] text-[var(--editorial-ink)] uppercase shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)]"
                >
                  Docs
                </Link>
              ) : null}
            </div>
          </FragmentPanel>
        ))}
      </div>
    </FragmentPageShell>
  );
}
