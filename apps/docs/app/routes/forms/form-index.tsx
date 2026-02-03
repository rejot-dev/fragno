import { useState, useEffect, type ComponentProps } from "react";
import { Palette, Database, FileJson, Check, Hammer } from "lucide-react";
import { JsonForms } from "@jsonforms/react";
import type { JsonSchema, UISchemaElement } from "@jsonforms/core";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";
import { SurveyAboutForms } from "../../components/survey-about-forms";
import { FormDemo } from "../../components/form-demo";
import { CopyFormsPromptButton } from "../../components/copy-forms-prompt-button";
import {
  FormBuilder,
  FormMetadataEditor,
  type GeneratedSchemas,
  type FormMetadata,
} from "@/components/form-builder";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Route } from "./+types/form-index";
import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { Link } from "react-router";
import { GitHub } from "@/components/logos/github";
import { FieldSeparator } from "@/components/ui/field";

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

// Wrapper that only renders JsonForms on the client
// (JsonForms uses Ajv which requires `new Function()` - not available in Workers)
function ClientSideJsonForms(props: Omit<ComponentProps<typeof JsonForms>, "renderers" | "cells">) {
  const isClient = useIsClient();

  if (!isClient) {
    return <div className="h-32 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />;
  }

  return <JsonForms {...props} renderers={shadcnRenderers} cells={shadcnCells} />;
}

// Form preview component
function FormPreview({ schemas }: { schemas: GeneratedSchemas | null }) {
  const [formData, setFormData] = useState({});

  if (!schemas || Object.keys(schemas.dataSchema.properties || {}).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Add fields to see your form preview here.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Preview</CardTitle>
      </CardHeader>
      <CardContent>
        <ClientSideJsonForms
          schema={schemas.dataSchema as JsonSchema}
          uischema={schemas.uiSchema as UISchemaElement}
          data={formData}
          onChange={({ data }) => setFormData(data)}
        />
      </CardContent>
    </Card>
  );
}

// =============================================================================
// PAGE
// =============================================================================

export default function FormsPage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  const isClient = useIsClient();
  const [schemas, setSchemas] = useState<GeneratedSchemas | null>(null);
  const [formMetadata, setFormMetadata] = useState<FormMetadata>({
    title: "",
    description: "",
    status: "open",
  });

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
          <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
            <Link
              to="/docs/forms"
              className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              View Docs
            </Link>
            <a
              href="https://github.com/rejot-dev/fragno"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <GitHub className="size-4" />
              Star on GitHub
            </a>
            <CopyFormsPromptButton />
          </div>
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
            <Link
              to="/docs/forms/shadcn-renderer"
              className="text-blue-600 underline dark:text-blue-400"
            >
              shadcn/ui renderer
            </Link>{" "}
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

        {/* Form Builder Section */}
        <section className="mx-auto max-w-6xl space-y-6">
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10 dark:bg-violet-400/20">
              <Hammer className="size-7 text-violet-600 dark:text-violet-400" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Form Builder <span className="text-violet-600 dark:text-violet-400">Included</span>
            </h2>
            <p className="text-fd-muted-foreground text-lg">
              Drop in the pre-built form builder component. Generates JSON Schema and JSON Forms UI
              Schema that you can use with any JSONForms renderer.
            </p>
          </div>
          {isClient && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Form Builder Demo</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-col gap-6">
                      <FormMetadataEditor value={formMetadata} onChange={setFormMetadata} />
                      <FieldSeparator />
                      <FormBuilder onChange={setSchemas} />
                    </div>
                  </CardContent>
                </Card>
              </div>
              <div className="lg:sticky lg:top-4 lg:self-start">
                <FormPreview schemas={schemas} />
              </div>
            </div>
          )}
        </section>

        {/* Divider */}
        <div className="mx-auto w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

        {/* Survey About Forms */}
        {isClient && <SurveyAboutForms turnstileSitekey={turnstileSitekey} />}

        {/* For linking to the form */}
        <div id="survey" />
      </div>
    </main>
  );
}
