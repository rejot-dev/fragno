import "../../backoffice.css";

import { useState } from "react";

import type { UISchemaElement } from "@jsonforms/core";

import { backofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { BackofficeJsonForm } from "@/components/backoffice/forms/backoffice-json-form";
import { ClientOnly } from "@/components/client-only";
import { formsClient } from "@/fragno/forms-client";

import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";
import type { Route } from "./+types/form";

export function loader({ params }: Route.LoaderArgs) {
  let scope;
  try {
    scope = backofficeContextScopeFromRouteParams(params);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  if (scope?.kind !== "system") {
    throw new Response("Not Found", { status: 404 });
  }

  return null;
}

export function meta() {
  return [
    { title: "Form · Backoffice" },
    { name: "description", content: "Submit a secure schema-backed form." },
  ];
}

export default function PublicFormRoute({ params }: Route.ComponentProps) {
  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <ClientOnly fallback={<PublicFormLoading />}>
          <PublicForm slug={params.slug} />
        </ClientOnly>
      </main>
      <LandingFooter />
    </div>
  );
}

function PublicForm({ slug }: { slug: string }) {
  const formState = formsClient.useForm({ path: { slug } });
  const submitForm = formsClient.useSubmitForm();
  const [responseId, setResponseId] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  if (formState.loading) {
    return <PublicFormLoading />;
  }
  if (formState.error || !formState.data) {
    return (
      <PublicFormMessage
        eyebrow="Unavailable"
        title="Form not found"
        description="This form does not exist or is no longer available."
      />
    );
  }

  const form = formState.data;
  if (form.status !== "open" && form.status !== "static") {
    return (
      <PublicFormMessage
        eyebrow="Closed"
        title="This form is not accepting responses"
        description="The form owner has not opened this form or has stopped collecting responses."
      />
    );
  }

  if (responseId) {
    return (
      <PublicFormMessage
        eyebrow="Submitted"
        title="Response received"
        description="Thank you. Your response was submitted successfully."
      />
    );
  }

  async function handleSubmit(data: Record<string, unknown>) {
    setSubmissionError(null);
    try {
      const submittedResponseId = await submitForm.mutate({
        path: { slug },
        body: { data },
      });
      if (!submittedResponseId) {
        throw new Error("The submission did not return a response id.");
      }
      setResponseId(submittedResponseId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : "The response could not be submitted.",
      );
    }
  }

  return (
    <section className="bo-fragment-surface bo-panel-surface w-full max-w-2xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 sm:p-8">
      <header className="border-b border-[color:var(--bo-border)] pb-5">
        <p className="text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-accent-fg)] uppercase">
          Form
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--bo-fg)]">
          {form.title}
        </h1>
        {form.description ? (
          <p className="mt-3 text-sm leading-6 text-[var(--bo-muted)]">{form.description}</p>
        ) : null}
      </header>

      {submissionError ? (
        <div role="alert" className="mt-5 border border-red-400/40 bg-red-500/8 p-3">
          <p className="text-sm text-red-700 dark:text-red-200">{submissionError}</p>
        </div>
      ) : null}

      <div className="mt-6">
        <BackofficeJsonForm
          schema={form.dataSchema}
          uiSchema={form.uiSchema as UISchemaElement | null | undefined}
          submitLabel="Submit response"
          submitting={submitForm.loading === true}
          onSubmit={handleSubmit}
        />
      </div>
    </section>
  );
}

function PublicFormLoading() {
  return (
    <div
      role="status"
      className="bo-panel-surface min-h-72 w-full max-w-2xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-8"
    >
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        Loading form
      </p>
    </div>
  );
}

function PublicFormMessage({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="bo-fragment-surface bo-panel-surface w-full max-w-xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-8 text-center">
      <p className="text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-accent-fg)] uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-[var(--bo-fg)]">{title}</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--bo-muted)]">
        {description}
      </p>
    </section>
  );
}
