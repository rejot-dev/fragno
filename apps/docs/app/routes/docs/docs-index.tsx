import { Lightbulb, ClipboardList, Workflow, Upload, Send, Shield, Mail } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { FragnoCircle } from "@/components/logos/fragno-circle";
import { Stripe } from "@/components/logos/stripe";
import { cn } from "@/lib/cn";

export function meta() {
  return [
    { title: "Documentation | Fragno" },
    { name: "description", content: "Fragno Documentation" },
  ];
}

interface DocCardProps {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
  variant?: "default" | "dashed";
  className?: string;
}

function DocCard({ href, icon, title, description, variant = "default", className }: DocCardProps) {
  const baseClasses =
    "group relative block overflow-hidden rounded-2xl p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:ring-white/10";
  const variantClasses =
    variant === "dashed"
      ? "border-2 border-dashed shadow-none dark:bg-slate-900/30"
      : "bg-white/90 dark:bg-slate-950/60 dark:from-slate-950/60 dark:via-slate-950/50 dark:to-slate-950/40";

  return (
    <Link to={href} className={cn(baseClasses, variantClasses, className)}>
      <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-gray-500/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-gray-400/15" />
      <div className="relative">
        <div className="mb-4 flex items-center gap-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-500/10 dark:bg-gray-400/20">
            {icon}
          </span>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        </div>
        <p className="text-fd-muted-foreground text-sm">{description}</p>
      </div>
    </Link>
  );
}

export default function DocsIndexPage() {
  return (
    <main className="flex min-h-screen flex-1 flex-col py-12">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <header className="relative mb-10 overflow-hidden rounded-3xl border border-black/5 bg-white/70 px-6 py-10 shadow-sm backdrop-blur sm:px-10 dark:border-white/10 dark:bg-slate-950/50">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute -top-16 -left-12 h-48 w-72 rounded-full bg-linear-to-br from-blue-500/15 via-sky-400/10 to-transparent blur-3xl" />
            <div className="absolute -right-16 -bottom-24 h-56 w-72 rounded-full bg-linear-to-br from-purple-500/14 via-fuchsia-400/10 to-transparent blur-3xl" />
          </div>

          <p className="text-fd-muted-foreground text-sm font-medium">Reference & guides</p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight md:text-5xl">Documentation</h1>
          <p className="text-fd-muted-foreground mt-3 max-w-2xl text-lg">
            Explore the Fragno framework and the first-party fragments for billing, email,
            messaging, forms, uploads, workflows, and auth.
          </p>
        </header>

        <div className="mb-10">
          <DocCard
            href="/docs/fragno"
            icon={<FragnoCircle className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Fragno Framework"
            description="Build portable full-stack TypeScript libraries that work across frameworks"
          />
        </div>

        <div className="mb-6 flex items-center gap-4">
          <div className="bg-fd-border h-px flex-1" />
          <h2 className="text-fd-muted-foreground text-xs font-medium tracking-wider uppercase">
            First Party Fragments
          </h2>
          <div className="bg-fd-border h-px flex-1" />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <DocCard
            href="/docs/stripe"
            icon={<Stripe className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Stripe Fragment"
            description="Batteries included integration for Stripe subscriptions"
          />
          <DocCard
            href="/docs/resend"
            icon={<Mail className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Resend Fragment"
            description="Typed outbound, inbound, and threaded email with local history"
          />
          <DocCard
            href="/docs/telegram"
            icon={<Send className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Telegram Fragment"
            description="Webhook-ready Telegram bots with commands and chat history"
          />
          <DocCard
            href="/docs/forms"
            icon={<ClipboardList className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Forms Fragment"
            description="Create forms and collect responses"
          />
          <DocCard
            href="/docs/workflows"
            icon={<Workflow className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Workflows Fragment"
            description="Durable workflows, runners, and dispatchers"
          />
          <DocCard
            href="/docs/upload"
            icon={<Upload className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Upload Fragment"
            description="Direct, multipart, and proxy file uploads"
          />
          <DocCard
            href="/docs/auth"
            icon={<Shield className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Auth Fragment"
            description="Users, sessions, organizations, and role-based access"
          />
          <DocCard
            href="https://rejot.dev/contact/"
            icon={<Lightbulb className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Got ideas for fragments?"
            description="Let us know what you'd like to see next."
            variant="dashed"
            className="md:col-span-2 lg:col-span-3"
          />
        </div>
      </div>
    </main>
  );
}
