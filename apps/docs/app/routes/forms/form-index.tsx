import { useState, useEffect } from "react";
import { Palette, Database, FileJson, Check } from "lucide-react";
import { SurveyAboutForms } from "../../components/survey-about-forms";
import { FormDemo } from "../../components/form-demo";
import type { Route } from "./+types/form-index";
import { CloudflareContext } from "@/cloudflare/cloudflare-context";

export function meta() {
  return [
    { title: "Fragno Forms" },
    {
      name: "description",
      content:
        "Build forms and collect responses. Based on open standards. Add to any application. Bring your own design.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(CloudflareContext);
  return {
    turnstileSitekey: env.TURNSTILE_SITEKEY,
  };
}

// Pass through server data on client navigations
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return await serverLoader();
}
clientLoader.hydrate = true as const;

// Hook to detect client-side rendering
function useIsClient() {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => {
    setIsClient(true);
  }, []);
  return isClient;
}

// =============================================================================
// PAGE
// =============================================================================

export default function FormsPage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  const isClient = useIsClient();

  return (
    <main className="relative min-h-screen">
      {/* Background gradient */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="bg-linear-to-br absolute -top-40 left-1/2 h-[600px] w-[1200px] -translate-x-1/2 from-blue-500/10 via-sky-400/5 to-slate-500/10 blur-3xl dark:from-blue-500/20 dark:via-sky-400/10 dark:to-slate-500/20" />
      </div>

      <div className="mx-auto max-w-7xl space-y-12 px-4 py-16 md:px-8">
        {/* Hero Section */}
        <section className="space-y-4 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
            Forms,{" "}
            <span className="bg-linear-to-r from-blue-600 to-sky-500 bg-clip-text text-transparent dark:from-blue-400 dark:to-sky-400">
              Simplified
            </span>
          </h1>
          <p className="text-fd-muted-foreground mx-auto max-w-2xl text-lg md:text-xl">
            Build forms and collect responses. Based on open standards. Add to any application.
            Bring your own design.
          </p>
        </section>

        {/* Bento Grid */}
        <FormDemo />

        {/* Divider */}
        <div className="mx-auto w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

        {/* Feature: Open Standards */}
        <section className="mx-auto max-w-3xl space-y-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 dark:bg-amber-400/20">
            <FileJson className="size-7 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Based on <span className="text-amber-600 dark:text-amber-400">Open Standards</span>
          </h2>
          <p className="text-fd-muted-foreground text-lg">
            Forms are defined using JSON Schema and{" "}
            <a
              href="https://jsonforms.io/"
              className="text-amber-600 underline dark:text-amber-400"
              target="_blank"
              rel="noopener noreferrer"
            >
              JSONForms UI Schema
            </a>
            . No proprietary formats—just portable, well-documented standards with broad tooling
            support.
          </p>
          <ul className="text-fd-muted-foreground mx-auto max-w-md space-y-3 text-left text-base">
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              JSON Schema for data structure and validation
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              JSONForms UI Schema for layout and presentation
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              Portable, tooling-friendly, AI-generatable
            </li>
          </ul>
        </section>

        {/* Divider */}
        <div className="mx-auto w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

        {/* Feature: Bring Your Own Components */}
        <section className="mx-auto max-w-3xl space-y-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 dark:bg-blue-400/20">
            <Palette className="size-7 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Bring Your <span className="text-blue-600 dark:text-blue-400">Own Components</span>
          </h2>
          <p className="text-fd-muted-foreground text-lg">
            Render forms using your existing component library. Use our{" "}
            <a
              href="https://www.npmjs.com/package/@fragno-dev/jsonforms-shadcn-renderers"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline dark:text-blue-400"
            >
              shadcn/ui renderer
            </a>{" "}
            or choose one of the community JSONForms renderers.
          </p>
          <ul className="text-fd-muted-foreground mx-auto max-w-md space-y-3 text-left text-base">
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              shadcn/ui renderer included
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              Compatible with existing JSONForms renderers
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              Forms inherit your theme and design system
            </li>
          </ul>
        </section>

        {/* Divider */}
        <div className="mx-auto w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

        {/* Feature: Your Database */}
        <section className="mx-auto max-w-3xl space-y-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 dark:bg-emerald-400/20">
            <Database className="size-7 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Store in <span className="text-emerald-600 dark:text-emerald-400">Your Database</span>
          </h2>
          <p className="text-fd-muted-foreground text-lg">
            Form submissions go directly to your database. Define forms dynamically at runtime or
            statically in code—your data stays in your infrastructure.
          </p>
          <ul className="text-fd-muted-foreground mx-auto max-w-md space-y-3 text-left text-base">
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              Define forms in code or at runtime
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              Works with Postgres, MySQL, SQLite, and more
            </li>
            <li className="flex items-center gap-3">
              <Check className="size-5 shrink-0 text-green-600 dark:text-green-400" />
              No third-party services, you own your data
            </li>
          </ul>
        </section>

        {/* Divider */}
        <div className="mx-auto w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

        {/* Survey About Forms */}
        {isClient && <SurveyAboutForms turnstileSitekey={turnstileSitekey} />}
      </div>
    </main>
  );
}
