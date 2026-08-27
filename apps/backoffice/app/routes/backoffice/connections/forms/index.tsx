import { useState, type SubmitEvent } from "react";
import { Link, useOutletContext } from "react-router";

import { BackofficeStatusLight } from "@/components/backoffice";
import { formsClient } from "@/fragno/forms-client";

import type { AutomationLayoutContext } from "../../automations/layout-context";
import { automationScopeBasePath } from "../../automations/scope";
import type { Route } from "./+types/index";

export function loader({ params }: Route.LoaderArgs) {
  if (params.scopeKind !== "system" || params.scopeId !== "system") {
    throw new Response("Not Found", { status: 404 });
  }

  return null;
}

export function meta() {
  return [{ title: "Forms · System" }];
}

export default function BackofficeFormsIntegration() {
  const { selectedScope } = useOutletContext<AutomationLayoutContext>();
  const integrationsPath = `${automationScopeBasePath(selectedScope)}/integrations`;
  const formsPath = `${integrationsPath}/forms`;
  const forms = formsClient.useForms();
  const createForm = formsClient.useCreateForm();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function handleCreateForm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    const normalizedTitle = title.trim();
    const normalizedSlug = slug.trim().toLowerCase();
    if (!normalizedTitle || !normalizedSlug) {
      setMessage("Title and slug are required.");
      return;
    }

    try {
      await createForm.mutate({
        body: {
          title: normalizedTitle,
          slug: normalizedSlug,
          status: "draft",
          dataSchema: { type: "object", properties: {} },
        },
      });
      setTitle("");
      setSlug("");
      setMessage("Draft form created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create the draft form.");
    }
  }

  return (
    <div className="space-y-4">
      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              System integration
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">Forms</h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--bo-muted)]">
              Create and inspect schema-backed forms in the global system scope.
            </p>
          </div>
          <Link
            to={integrationsPath}
            className="border border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:text-[var(--bo-fg)]"
          >
            All integrations
          </Link>
        </div>
      </section>

      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <h2 className="text-lg font-semibold text-[var(--bo-fg)]">Create a draft form</h2>
        <form
          onSubmit={(event) => void handleCreateForm(event)}
          className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]"
        >
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            placeholder="Form title"
            aria-label="Form title"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)]"
          />
          <input
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
            placeholder="form-slug"
            aria-label="Form slug"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)]"
          />
          <button
            type="submit"
            disabled={createForm.loading}
            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase disabled:opacity-60"
          >
            {createForm.loading ? "Creating…" : "Create draft"}
          </button>
        </form>
        {message ? <p className="mt-3 text-xs text-[var(--bo-muted)]">{message}</p> : null}
      </section>

      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <h2 className="text-lg font-semibold text-[var(--bo-fg)]">Forms</h2>
        {forms.error ? (
          <p className="mt-3 text-xs text-red-500">{forms.error.message}</p>
        ) : forms.loading ? (
          <p className="mt-3 text-xs text-[var(--bo-muted)]">Loading forms…</p>
        ) : (
          <div className="mt-4 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
            {(forms.data ?? []).length === 0 ? (
              <p className="py-3 text-sm text-[var(--bo-muted)]">No system forms yet.</p>
            ) : (
              (forms.data ?? []).map((form) => (
                <div key={form.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--bo-fg)]">{form.title}</p>
                    <p className="truncate text-xs text-[var(--bo-muted)]">/{form.slug}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <BackofficeStatusLight tone={form.status === "open" ? "live" : "muted"}>
                      {form.status}
                    </BackofficeStatusLight>
                    <Link
                      to={`${formsPath}/${form.id}`}
                      className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] px-3 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[border-color,color,scale] duration-150 hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
                    >
                      View
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
