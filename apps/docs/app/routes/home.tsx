import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { Package, Route as RouteIcon, Layers } from "lucide-react";

import Frameworks from "@/components/frameworks";
import { DatabaseSupport } from "@/components/database-support";
import type { Route } from "./+types/home";
import { getMailingListDurableObject } from "@/cloudflare/cloudflare-utils";
import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { validateTurnstileToken } from "@/cloudflare/turnstile";
import { CommunitySection } from "@/components/community-section";
import { SkillCta } from "@/components/skill-cta";

export function meta() {
  return [
    { title: "Fragno for Users: Integrate Full-Stack Fragments" },
    {
      name: "description",
      content:
        "Integrate full-stack fragments into your app with typed hooks, server routes, and database schemas included.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(CloudflareContext);
  return {
    turnstileSitekey: env.TURNSTILE_SITEKEY,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(CloudflareContext);
  const formData = await request.formData();
  const email = formData.get("email");

  if (!email || typeof email !== "string") {
    return {
      success: false,
      message: "Email is required",
    };
  }

  const turnstileToken = formData.get("cf-turnstile-response");
  if (!turnstileToken || typeof turnstileToken !== "string") {
    return {
      success: false,
      message: "Turnstile token is required",
    };
  }

  const turnstileResult = await validateTurnstileToken(env.TURNSTILE_SECRET_KEY, turnstileToken);
  if (!turnstileResult.success) {
    return {
      success: false,
      message: "Turnstile validation failed",
    };
  }

  try {
    const mailingListDo = getMailingListDurableObject(context);
    await mailingListDo.subscribe(email);

    return {
      success: true,
      message: "Successfully subscribed!",
    };
  } catch (error) {
    console.error("Mailing list subscription error:", error);
    return {
      success: false,
      message: "Failed to subscribe. Please try again.",
    };
  }
}

function Hero() {
  return (
    <section className="w-full max-w-6xl py-6 md:py-10">
      <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div className="space-y-6">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-6xl">
            Integrate full-stack libraries in minutes
          </h1>
          <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
            Drop in auth, billing, forms, or workflows without stitching backend routes, database
            tables, and frontend hooks by hand.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              to="/docs/fragno/user-quick-start"
              className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              User Quick Start
            </Link>
            <Link
              to="/fragments"
              className="rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Explore Fragments
            </Link>
          </div>
          <p className="text-fd-muted-foreground text-sm">
            Building fragments instead?{" "}
            <Link to="/authors" className="font-medium text-blue-600 hover:underline">
              Visit the fragment author overview
            </Link>
          </p>
        </div>

        <SkillCta
          title="Install the Fragno Skill"
          command="npx skills add https://github.com/rejot-dev/fragno --skill fragno"
          description='Then ask: "Use the fragno skill to integrate the Stripe fragment into my app."'
        />
      </div>
    </section>
  );
}

type StepCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
};

function StepCard({ icon, title, description }: StepCardProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/90 p-6 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center rounded-xl bg-blue-500/10 p-3 text-2xl text-blue-600 dark:bg-blue-400/20 dark:text-blue-300">
          {icon}
        </span>
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h3>
          <p className="text-fd-muted-foreground mt-1 text-sm">{description}</p>
        </div>
      </div>
    </div>
  );
}

function UserFlow() {
  const steps = [
    {
      icon: <Package className="size-6" />,
      title: "Install a fragment",
      description: "Add a full-stack feature like billing or auth as a package, not a rewrite.",
    },
    {
      icon: <RouteIcon className="size-6" />,
      title: "Mount routes once",
      description:
        "Register fragment routes on your server adapter and configure environment bindings.",
    },
    {
      icon: <Layers className="size-6" />,
      title: "Use typed hooks",
      description: "Call framework-specific hooks and stores with end-to-end type safety.",
    },
  ];

  return (
    <section className="w-full max-w-6xl space-y-8">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">How it works</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Fragments ship the server, database, and client glue so you can focus on product.
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {steps.map((step) => (
          <StepCard key={step.title} {...step} />
        ))}
      </div>
    </section>
  );
}

type ShowcaseItem = {
  id: "auth" | "stripe" | "upload" | "forms" | "workflows";
  label: string;
  title: ReactNode;
  titlePlain: string;
  summary: string;
  description: string;
  installCommand: string;
  details: string[];
  href: string;
  docsHref: string;
  cta: string;
  glowClass: string;
  dotClass: string;
  ctaClass: string;
  activeRing: string;
  comingSoon?: boolean;
};

const showcaseItems: ShowcaseItem[] = [
  {
    id: "stripe",
    label: "Billing",
    title: (
      <>
        <span className="bg-linear-to-r from-violet-600 to-purple-500 bg-clip-text text-transparent dark:from-violet-400 dark:to-purple-400">
          Stripe
        </span>{" "}
        Billing
      </>
    ),
    titlePlain: "Stripe Billing",
    summary: "Manage subscriptions using Stripe",
    description: "Stripe Checkout, webhooks, and subscription management.",
    installCommand: "npm install @fragno-dev/stripe",
    details: [
      "Keep track of subscriptions status in your database.",
      "Webhook handlers included.",
      "Hooks for creating/cancelling/upgrading subscription plans.",
    ],
    href: "/fragments/stripe",
    docsHref: "/docs/stripe",
    cta: "Stripe Overview",
    glowClass: "bg-violet-500/10 dark:bg-violet-400/15",
    dotClass: "bg-violet-500/70 dark:bg-violet-400/70",
    ctaClass: "bg-violet-600 hover:bg-violet-700",
    activeRing: "ring-violet-500/30 dark:ring-violet-400/30",
  },
  {
    id: "forms",
    label: "Forms and Surveys",
    title: (
      <span className="bg-linear-to-r from-blue-600 to-sky-500 bg-clip-text text-transparent dark:from-blue-400 dark:to-sky-400">
        Forms
      </span>
    ),
    titlePlain: "Forms",
    summary: "Build forms and collect responses.",
    description:
      "Form definitions, submission handling, and response storage built on open standards.",
    installCommand: "npm install @fragno-dev/forms",
    details: [
      "Built on JSON Schema + JSON Forms.",
      "Render beautiful forms with shadcn/ui",
      "User friendly form builder included.",
    ],
    href: "/fragments/forms",
    docsHref: "/docs/forms",
    cta: "Forms Overview",
    glowClass: "bg-blue-500/10 dark:bg-blue-400/15",
    dotClass: "bg-blue-500/70 dark:bg-blue-400/70",
    ctaClass: "bg-blue-600 hover:bg-blue-700",
    activeRing: "ring-blue-500/30 dark:ring-blue-400/30",
  },
  {
    id: "workflows",
    label: "Workflows",
    title: (
      <>
        <span className="bg-linear-to-r from-amber-600 to-orange-500 bg-clip-text text-transparent dark:from-amber-400 dark:to-orange-300">
          Durable Workflow
        </span>{" "}
        Runtime
      </>
    ),
    titlePlain: "Durable Workflows",
    summary: "Queues, retries, and durable state.",
    description: "Queues, retries, and durable state for background work.",
    installCommand: "npm install @fragno-dev/workflows",
    details: [
      "Steps, timers, retries, and external events.",
      "Runner + dispatcher model for durable execution.",
      "Test harness for deterministic workflow runs.",
    ],
    href: "/fragments/workflows",
    docsHref: "/docs/workflows",
    cta: "Workflows Overview",
    glowClass: "bg-amber-500/10 dark:bg-amber-400/15",
    dotClass: "bg-amber-500/70 dark:bg-amber-400/70",
    ctaClass: "bg-amber-600 hover:bg-amber-700",
    activeRing: "ring-amber-500/30 dark:ring-amber-400/30",
  },
  {
    id: "auth",
    label: "Auth",
    title: (
      <span className="bg-linear-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent dark:from-emerald-400 dark:to-teal-300">
        Authentication
      </span>
    ),
    titlePlain: "Authentication",
    summary: "User and session management.",
    description: "User and session management.",
    installCommand: "npm install @fragno-dev/auth",
    details: [],
    href: "/fragments/auth",
    docsHref: "/docs/auth",
    cta: "Auth Overview",
    glowClass: "bg-emerald-500/10 dark:bg-emerald-400/15",
    dotClass: "bg-emerald-500/70 dark:bg-emerald-400/70",
    ctaClass: "bg-emerald-600 hover:bg-emerald-700",
    activeRing: "ring-emerald-500/30 dark:ring-emerald-400/30",
  },
  {
    id: "upload",
    label: "File Uploads",
    title: (
      <>
        <span className="bg-linear-to-r from-cyan-600 to-sky-500 bg-clip-text text-transparent dark:from-cyan-400 dark:to-sky-300">
          File
        </span>{" "}
        Uploads
      </>
    ),
    titlePlain: "File Uploads",
    summary: "Uploads, metadata, and access hooks.",
    description: "Upload flows, metadata storage, and client hooks for files.",
    installCommand: "npm install @fragno-dev/upload",
    details: [],
    href: "/fragments/upload",
    docsHref: "/docs/upload/overview",
    cta: "Uploads Overview",
    glowClass: "bg-cyan-500/10 dark:bg-cyan-400/15",
    dotClass: "bg-cyan-500/70 dark:bg-cyan-400/70",
    ctaClass: "bg-cyan-600 hover:bg-cyan-700",
    activeRing: "ring-cyan-500/30 dark:ring-cyan-400/30",
  },
];

function FragmentShowcase() {
  const [activeId, setActiveId] = useState<ShowcaseItem["id"]>(showcaseItems[0].id);
  const activeItem = showcaseItems.find((item) => item.id === activeId) ?? showcaseItems[0];

  return (
    <section className="w-full max-w-6xl space-y-8">
      <div className="space-y-3 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">First Party Fragments</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Production-ready integrations you can drop into your app today.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 md:p-10 dark:bg-slate-950/60 dark:ring-white/10">
          <span
            className={`absolute inset-x-6 -top-16 h-28 rounded-full opacity-80 blur-3xl ${activeItem.glowClass}`}
          />
          <div className="relative flex h-full flex-col justify-between gap-6">
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-fd-muted-foreground text-sm font-medium">{activeItem.label}</p>
                {activeItem.comingSoon && (
                  <span className="rounded-full border border-amber-400/30 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Coming soon
                  </span>
                )}
              </div>
              <h3 className="text-3xl font-extrabold tracking-tight md:text-4xl">
                {activeItem.title}
              </h3>
              <p className="text-fd-muted-foreground max-w-xl text-lg">{activeItem.description}</p>
              <div className="space-y-2">
                <ul className="grid gap-2 text-sm text-slate-600 dark:text-slate-300">
                  {activeItem.details.map((detail) => (
                    <li key={detail} className="flex gap-2">
                      <span
                        aria-hidden
                        className="mt-2 inline-flex h-1.5 w-1.5 rounded-full bg-slate-400/70 dark:bg-slate-500/70"
                      />
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2 pt-2">
                <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  Install
                </p>
                <FragnoCodeBlock
                  lang="bash"
                  code={activeItem.installCommand}
                  allowCopy
                  className="rounded-xl"
                />
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  to={activeItem.href}
                  className={`group inline-flex items-center gap-2 rounded-lg px-6 py-3 font-semibold text-white shadow-sm transition-colors ${activeItem.ctaClass}`}
                >
                  {activeItem.cta}
                </Link>
                <Link
                  to={activeItem.docsHref}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                >
                  Docs
                  <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {showcaseItems.map((item) => {
            const isActive = item.id === activeId;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveId(item.id)}
                aria-pressed={isActive}
                className={`group w-full rounded-2xl border border-black/5 bg-white/80 p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-white/10 dark:bg-slate-950/60 ${
                  isActive ? `ring-2 ${item.activeRing}` : ""
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                        {item.label}
                      </p>
                      {item.comingSoon && (
                        <span className="inline-flex rounded-full border border-amber-400/30 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          Coming soon
                        </span>
                      )}
                    </div>
                    <p className="text-lg font-semibold text-gray-900 dark:text-white">
                      {item.titlePlain}
                    </p>
                    <p className="text-fd-muted-foreground text-sm">{item.summary}</p>
                  </div>
                  <span
                    className={`mt-1 inline-flex h-2.5 w-2.5 rounded-full ${item.dotClass}`}
                    aria-hidden
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AuthorCta() {
  return (
    <section className="w-full max-w-5xl">
      <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-8 py-10 text-white shadow-xl">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-40 w-40 rounded-full bg-blue-500/30 blur-3xl" />
          <div className="absolute -right-10 bottom-0 h-40 w-40 rounded-full bg-purple-500/30 blur-3xl" />
        </div>
        <div className="relative flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-200">
              Building fragments?
            </p>
            <h2 className="text-3xl font-bold">Create portable full-stack libraries</h2>
            <p className="text-blue-100">
              Learn how to ship full-stack libraries with routes, hooks, and database schemas.
            </p>
          </div>
          <Link
            to="/authors"
            className="rounded-lg bg-white px-6 py-3 font-semibold text-slate-900 shadow-sm transition-colors hover:bg-slate-100"
          >
            Author Overview
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function HomePage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  return (
    <main className="relative flex flex-1 flex-col items-center space-y-12 overflow-x-hidden px-4 py-10 md:px-8 md:py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-linear-to-br opacity-4 mx-auto -mt-20 h-[520px] w-[1000px] from-blue-500 via-sky-400 to-purple-500 blur-3xl dark:opacity-15" />
      </div>

      <Hero />
      <FragmentShowcase />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <UserFlow />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <Frameworks />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <DatabaseSupport />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <CommunitySection turnstileSitekey={turnstileSitekey} />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <AuthorCta />
    </main>
  );
}
