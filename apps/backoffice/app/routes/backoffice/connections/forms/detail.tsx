import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";

import type { FormResponse } from "@fragno-dev/forms";

import type { UISchemaElement } from "@jsonforms/core";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { BackofficeStatusLight } from "@/components/backoffice";
import { BackofficeJsonForm } from "@/components/backoffice/forms/backoffice-json-form";
import { formsClient } from "@/fragno/forms-client";

import type { AutomationLayoutContext } from "../../automations/layout-context";
import { automationScopeBasePath } from "../../automations/scope";
import type { Route } from "./+types/detail";

const SUBMISSIONS_PAGE_SIZE = 25;

const submittedAtFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatSubmittedAt(value: unknown) {
  const submittedAt =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return submittedAt && Number.isFinite(submittedAt.getTime())
    ? submittedAtFormatter.format(submittedAt)
    : "Unknown submission time";
}

function appendUniqueFormSubmissions(
  current: FormResponse[],
  nextPage: FormResponse[],
): FormResponse[] {
  const currentIds = new Set(current.map((submission) => submission.id));
  return [...current, ...nextPage.filter((submission) => !currentIds.has(submission.id))];
}

export function loader({ params }: Route.LoaderArgs) {
  if (params.scopeKind !== "system" || params.scopeId !== "system") {
    throw new Response("Not Found", { status: 404 });
  }

  return null;
}

export function meta() {
  return [{ title: "Form details · System" }];
}

export default function BackofficeFormDetail(props: Route.ComponentProps) {
  return <BackofficeFormDetailPage key={props.params.formId} {...props} />;
}

function BackofficeFormDetailPage({ params }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<AutomationLayoutContext>();
  const formsPath = `${automationScopeBasePath(selectedScope)}/integrations/forms`;
  const [submissionCursor, setSubmissionCursor] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<FormResponse[]>([]);
  const formState = formsClient.useFormById({ path: { id: params.formId } });
  const submissionsState = formsClient.useSubmissions({
    path: { id: params.formId },
    query: {
      sortOrder: "desc",
      pageSize: String(SUBMISSIONS_PAGE_SIZE),
      cursor: submissionCursor ?? undefined,
    },
  });

  useEffect(() => {
    const page = submissionsState.data;
    if (!page) {
      return;
    }

    setSubmissions((current) =>
      submissionCursor === null
        ? page.submissions
        : appendUniqueFormSubmissions(current, page.submissions),
    );
  }, [submissionCursor, submissionsState.data]);

  if (formState.loading) {
    return <FormDetailState title="Loading form…" />;
  }
  if (formState.error || !formState.data) {
    return (
      <FormDetailState
        title="Unable to load form"
        description={formState.error?.message ?? "The form could not be found."}
      />
    );
  }

  const form = formState.data;
  const nextSubmissionCursor = submissionsState.data?.hasNextPage
    ? submissionsState.data.nextCursor
    : null;
  const publicPath = `/forms/${backofficeRouteScopePath({ kind: "system" })}/${encodeURIComponent(form.slug)}`;

  return (
    <div className="space-y-4">
      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Form dashboard
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold text-[var(--bo-fg)]">{form.title}</h1>
              <BackofficeStatusLight tone={form.status === "open" ? "live" : "muted"}>
                {form.status}
              </BackofficeStatusLight>
            </div>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">/{form.slug}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(form.status === "open" || form.status === "static") && (
              <Link
                to={publicPath}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-accent-fg)] uppercase"
              >
                Open public form
              </Link>
            )}
            <Link
              to={formsPath}
              className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)]"
            >
              All forms
            </Link>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
          <div className="border-b border-[color:var(--bo-border)] pb-3">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Interactive preview
            </p>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">
              Preview values stay in this browser and are not submitted.
            </p>
          </div>
          <div className="mx-auto mt-5 max-w-2xl">
            <BackofficeJsonForm
              key={`${form.id}:${form.version}`}
              schema={form.dataSchema}
              uiSchema={form.uiSchema as UISchemaElement | null | undefined}
            />
          </div>
        </section>

        <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
          <div className="flex items-end justify-between gap-3 border-b border-[color:var(--bo-border)] pb-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Submissions
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                {submissions.length} loaded {submissions.length === 1 ? "response" : "responses"}
              </h2>
            </div>
            <span className="text-xs text-[var(--bo-muted-2)]">Newest first</span>
          </div>

          {submissionsState.error ? (
            <p className="mt-4 text-sm text-red-500">{submissionsState.error.message}</p>
          ) : null}
          {submissionsState.loading && submissions.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--bo-muted)]">Loading submissions…</p>
          ) : submissionsState.error && submissions.length === 0 ? null : submissions.length ===
            0 ? (
            <p className="mt-4 text-sm text-[var(--bo-muted)]">No submissions yet.</p>
          ) : (
            <>
              <ol className="mt-4 space-y-3">
                {submissions.map((submission) => (
                  <li
                    key={submission.id}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <time className="text-xs font-medium text-[var(--bo-fg)]">
                        {formatSubmittedAt(submission.submittedAt)}
                      </time>
                      <span className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        Version {submission.formVersion}
                      </span>
                    </div>
                    <pre className="mt-3 max-h-72 overflow-auto text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
                      {JSON.stringify(submission.data, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
              {nextSubmissionCursor ? (
                <button
                  type="button"
                  className="mt-4 min-h-10 w-full border border-[color:var(--bo-border)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)] disabled:cursor-wait disabled:opacity-60"
                  disabled={submissionsState.loading}
                  onClick={() => {
                    setSubmissionCursor(nextSubmissionCursor);
                  }}
                >
                  {submissionsState.loading ? "Loading…" : "Load more responses"}
                </button>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function FormDetailState({ title, description }: { title: string; description?: string }) {
  return (
    <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-6">
      <h1 className="text-xl font-semibold text-[var(--bo-fg)]">{title}</h1>
      {description ? <p className="mt-2 text-sm text-[var(--bo-muted)]">{description}</p> : null}
    </section>
  );
}
