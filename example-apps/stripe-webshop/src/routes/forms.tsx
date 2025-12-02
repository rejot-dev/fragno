import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { JsonForms } from "@jsonforms/react";
import { vanillaCells, vanillaRenderers } from "@jsonforms/vanilla-renderers";
import { formsClient } from "@/lib/forms.client";
import type { UISchemaElement } from "@jsonforms/core";

const FORM_ID = "dbqrdoiy243t6uxyvpp7r437";

export const Route = createFileRoute("/forms")({
  component: FormsPage,
});

function FormsPage() {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const {
    data: form,
    loading: formLoading,
    error: formError,
  } = formsClient.useForm({ path: { id: FORM_ID } });

  const { data: submissions, loading: submissionsLoading } = formsClient.useSubmissions({
    path: { id: FORM_ID },
  });
  const {
    mutate: submitForm,
    loading: submitLoading,
    error: submitError,
    data: submissionId,
  } = formsClient.useSubmitForm();

  const handleSubmit = async () => {
    await submitForm({
      path: { id: FORM_ID },
      body: { data: formData },
    });
  };

  if (formLoading) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <p className="text-muted-foreground">Loading form...</p>
      </div>
    );
  }

  if (formError || !form) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          Error loading form: {formError?.message ?? "Form not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh w-full flex-col items-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-xl space-y-6">
        <h1 className="text-2xl font-bold">{form.title}</h1>
        {form.description && <p className="text-muted-foreground">{form.description}</p>}

        <div className="rounded-lg border p-6">
          {/* Schema types are stored as Record<string, unknown> but are valid JSON Schema / UI Schema */}
          <JsonForms
            schema={form.dataSchema}
            uischema={form.uiSchema as unknown as UISchemaElement}
            data={formData}
            renderers={vanillaRenderers}
            cells={vanillaCells}
            onChange={({ data }) => setFormData(data ?? {})}
          />

          <button
            onClick={handleSubmit}
            disabled={submitLoading}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 w-full rounded px-4 py-2 disabled:opacity-50"
          >
            {submitLoading ? "Submitting..." : "Submit"}
          </button>
        </div>

        {submitError && (
          <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
            Error: {submitError.message}
          </div>
        )}

        {submissionId && (
          <div className="rounded-lg border border-green-500 bg-green-500/10 p-4 text-green-700">
            Form submitted successfully! Response ID: {submissionId}
          </div>
        )}

        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Submissions</h2>
          {submissionsLoading && <p className="text-muted-foreground">Loading submissions...</p>}
          {submissions && submissions.length === 0 && (
            <p className="text-muted-foreground">No submissions yet.</p>
          )}
          {submissions && submissions.length > 0 && (
            <div className="space-y-3">
              {submissions.map((submission) => (
                <div key={submission.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">
                      {new Date(submission.submittedAt).toLocaleString()}
                    </span>
                    <span className="text-muted-foreground text-xs">v{submission.formVersion}</span>
                  </div>
                  <pre className="bg-muted overflow-auto rounded p-2 text-sm">
                    {JSON.stringify(submission.data, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
