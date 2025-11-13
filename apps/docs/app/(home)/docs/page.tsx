import { Lightbulb } from "lucide-react";
import { Stripe } from "@/components/logos/stripe";
import { FragnoCircle } from "@/components/logos/fragno-circle";
import Link from "next/link";
import type { ReactNode } from "react";

interface DocCardProps {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
  variant?: "default" | "dashed";
}

function DocCard({ href, icon, title, description, variant = "default" }: DocCardProps) {
  const baseClasses =
    "group relative block overflow-hidden rounded-2xl p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:ring-white/10";
  const variantClasses =
    variant === "dashed"
      ? "border-2 border-dashed shadow-none dark:bg-slate-900/30"
      : "bg-white/90 dark:bg-slate-950/60 dark:from-slate-950/60 dark:via-slate-950/50 dark:to-slate-950/40";

  return (
    <Link href={href} className={`${baseClasses} ${variantClasses}`}>
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

export default function DocsPage() {
  return (
    <main className="container flex min-h-screen flex-1 flex-col items-center py-16">
      <div className="w-full max-w-2xl">
        <h1 className="mb-12 text-center text-3xl font-semibold md:text-4xl">Documentation</h1>

        {/* Fragno Framework */}
        <div className="mb-12">
          <DocCard
            href="/docs/fragno"
            icon={<FragnoCircle className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Fragno Framework"
            description="Build portable full-stack TypeScript libraries that work across frameworks"
          />
        </div>

        {/* Our Fragments Section */}
        <div className="mb-6 flex items-center gap-4">
          <div className="bg-fd-border h-px flex-1" />
          <h2 className="text-fd-muted-foreground text-xs font-medium uppercase tracking-wider">
            Our Fragments
          </h2>
          <div className="bg-fd-border h-px flex-1" />
        </div>

        {/* Fragments Grid */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DocCard
            href="/docs/stripe"
            icon={<Stripe className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Stripe Fragment"
            description="Batteries included integration for Stripe Subscriptions"
          />
          <DocCard
            href="https://rejot.dev/contact/"
            icon={<Lightbulb className="size-6 text-gray-700 dark:text-gray-300" />}
            title="Got ideas for fragments?"
            description="Let us know what you'd like to see!"
            variant="dashed"
          />
        </div>
      </div>
    </main>
  );
}
