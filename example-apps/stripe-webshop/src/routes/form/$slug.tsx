import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { JsonForms } from "@jsonforms/react";
import { formsClient } from "@/lib/forms.client";
import type { UISchemaElement } from "@jsonforms/core";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/form/$slug")({
  component: FormDisplayPage,
});

function FormDisplayPage() {
  const { slug } = Route.useParams();
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  const {
    data: form,
    loading: formLoading,
    error: formError,
  } = formsClient.useForm({ path: { slug: slug || "" } });

  const {
    mutate: submitForm,
    loading: submitLoading,
    error: submitError,
    data: submissionId,
  } = formsClient.useSubmitForm();

  const handleSubmit = async () => {
    await submitForm({
      path: { slug },
      body: { data: formData },
    });
  };

  if (formLoading || !form) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <p className="text-muted-foreground">Loading form...</p>
      </div>
    );
  }

  if (formError) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          {formError ? `[${formError.code}]: ${formError.message}` : "Form not found"}
        </div>
      </div>
    );
  }

  const isFormOpen = form?.status === "open";

  return (
    <div className="flex min-h-svh w-full flex-col items-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{form.title}</h1>
          {form.description && <p className="text-muted-foreground mt-1">{form.description}</p>}
        </div>

        <div className="rounded-lg border p-6">
          <span
            className={`mb-4 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              form.status === "open"
                ? "bg-green-100 text-green-700"
                : form.status === "closed"
                  ? "bg-red-100 text-red-700"
                  : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {form.status}
          </span>

          <JsonForms
            schema={form.dataSchema}
            uischema={
              form.uiSchema && Object.keys(form.uiSchema).length > 0
                ? (form.uiSchema as unknown as UISchemaElement)
                : undefined
            }
            data={formData}
            renderers={shadcnRenderers}
            cells={shadcnCells}
            onChange={({ data }) => setFormData(data ?? {})}
          />

          <Button
            onClick={handleSubmit}
            disabled={submitLoading || !isFormOpen}
            className="mt-4 w-full"
          >
            {submitLoading ? "Submitting..." : "Submit"}
          </Button>

          {!isFormOpen && (
            <p className="text-muted-foreground mt-2 text-center text-sm">
              This form is not accepting submissions.
            </p>
          )}
        </div>

        {submitError && (
          <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
            Error: {submitError.message}
          </div>
        )}

        {submissionId && (
          <div className="rounded-lg border border-green-500 bg-green-500/10 p-4 text-green-700">
            Form submitted successfully! Thank you for your response.
          </div>
        )}
      </div>
    </div>
  );
}
