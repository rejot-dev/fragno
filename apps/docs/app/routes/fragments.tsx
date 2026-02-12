import { Link } from "react-router";
import { Package, ArrowRight } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function meta() {
  return [
    { title: "Fragno Fragments" },
    {
      name: "description",
      content:
        "Explore Fragno first-party fragments for billing, forms, workflows, uploads, and more.",
    },
  ];
}

type FragmentStatus = "available" | "coming";

type FragmentCard = {
  id: "stripe" | "forms" | "workflows" | "upload" | "auth";
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
    accentText: "text-violet-600 dark:text-violet-300",
    accentDot: "bg-violet-500/80 dark:bg-violet-400/80",
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
    accentText: "text-sky-600 dark:text-sky-300",
    accentDot: "bg-sky-500/80 dark:bg-sky-400/80",
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
    accentText: "text-amber-600 dark:text-amber-300",
    accentDot: "bg-amber-500/80 dark:bg-amber-400/80",
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
    accentText: "text-cyan-600 dark:text-cyan-300",
    accentDot: "bg-cyan-500/80 dark:bg-cyan-400/80",
  },
  {
    id: "auth",
    name: "Authentication",
    category: "Auth",
    description: "Authentication fragment for users, sessions, and app security.",
    status: "available",
    href: "/fragments/auth",
    docsHref: "/docs/auth",
    install: "npm install @fragno-dev/auth",
    accentText: "text-emerald-600 dark:text-emerald-300",
    accentDot: "bg-emerald-500/80 dark:bg-emerald-400/80",
  },
];

function StatusBadge({ status }: { status: FragmentStatus }) {
  if (status === "available") {
    return (
      <span className="rounded-full border border-emerald-400/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300">
        Available
      </span>
    );
  }
  return (
    <span className="rounded-full border border-amber-400/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-400/30 dark:text-amber-300">
      Coming soon
    </span>
  );
}

export default function FragmentsPage() {
  return (
    <main className="relative min-h-screen">
      <div className="mx-auto max-w-6xl space-y-12 px-4 py-16 md:px-8">
        <section className="space-y-4 text-center">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:border-white/10 dark:text-slate-300">
            <Package className="size-4" />
            First Party Fragments
          </p>
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
            Ready-made fragments for your product stack
          </h1>
          <p className="text-fd-muted-foreground mx-auto max-w-2xl text-lg md:text-xl">
            Pick a fragment, follow the quickstart, and ship full-stack features without wiring the
            server, database, and client glue yourself.
          </p>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          {fragments.map((fragment) => (
            <article
              key={fragment.id}
              className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p
                      className={`text-xs font-semibold uppercase tracking-wide ${fragment.accentText}`}
                    >
                      {fragment.category}
                    </p>
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                      {fragment.name}
                    </h2>
                  </div>
                  <StatusBadge status={fragment.status} />
                </div>
                <p className="text-fd-muted-foreground text-sm">{fragment.description}</p>

                {fragment.highlights && fragment.highlights.length > 0 && (
                  <ul className="text-fd-muted-foreground grid gap-2 text-sm">
                    {fragment.highlights.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span
                          aria-hidden
                          className={`mt-2 inline-flex h-1.5 w-1.5 rounded-full ${fragment.accentDot}`}
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {fragment.install && (
                  <div className="space-y-2">
                    <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                      Install
                    </p>
                    <FragnoCodeBlock
                      lang="bash"
                      code={fragment.install}
                      allowCopy
                      className="rounded-xl"
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Link
                    to={fragment.href}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                  >
                    Overview
                    <ArrowRight className="size-4" />
                  </Link>
                  {fragment.docsHref && (
                    <Link
                      to={fragment.docsHref}
                      className="inline-flex items-center gap-2 rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-100 dark:border-white/15 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Docs
                    </Link>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
