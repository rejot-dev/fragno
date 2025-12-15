import { useState } from "react";
import { JsonForms } from "@jsonforms/react";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";
import { ClipboardList, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { surveyForm, SURVEY_FORM_SLUG } from "@/fragno/static-forms";
import { formsClient } from "@/fragno/forms.client";
import { Turnstile } from "@marsidev/react-turnstile";

interface SurveyAboutFormsProps {
  turnstileSitekey: string;
}

export function SurveyAboutForms({ turnstileSitekey }: SurveyAboutFormsProps) {
  const [data, setData] = useState({});
  const [errors, setErrors] = useState<{ message?: string }[]>([]);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const { mutate: submitForm, loading, error, data: responseId } = formsClient.useSubmitForm();

  const handleSubmit = async () => {
    if (!turnstileToken) {
      return;
    }

    await submitForm({
      path: { slug: SURVEY_FORM_SLUG },
      body: { data, securityToken: turnstileToken },
    });
  };

  if (responseId) {
    return (
      <section className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/20 dark:bg-green-400/30">
            <CheckCircle className="size-8 text-green-600 dark:text-green-400" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Thank you!</h2>
          <p className="text-fd-muted-foreground mx-auto max-w-xl text-lg">
            Your feedback has been submitted. We appreciate you taking the time to share your
            thoughts!
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-4 text-center">
        <div className="bg-linear-to-br mx-auto flex h-16 w-16 items-center justify-center rounded-2xl from-blue-500/20 to-sky-500/20 dark:from-blue-400/30 dark:to-sky-400/30">
          <ClipboardList className="size-8 text-blue-600 dark:text-blue-400" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">A Form about Forms</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-xl text-lg">
          Tell us about your form needs. (NOT A DEMO!)
        </p>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-4 relative flex flex-col gap-8 overflow-hidden rounded-2xl bg-white/90 p-6 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
        <JsonForms
          schema={surveyForm.dataSchema}
          uischema={surveyForm.uiSchema}
          data={data}
          renderers={shadcnRenderers}
          cells={shadcnCells}
          onChange={({ data, errors }) => {
            setData(data);
            setErrors(errors ?? []);
          }}
        />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
            {error.message}
          </div>
        )}

        <Turnstile
          siteKey={turnstileSitekey}
          onSuccess={setTurnstileToken}
          options={{ appearance: "interaction-only" }}
        />

        <Button onClick={handleSubmit} disabled={loading || !turnstileToken || errors.length > 0}>
          {loading ? "Submitting..." : "Submit"}
        </Button>
      </div>
    </section>
  );
}
