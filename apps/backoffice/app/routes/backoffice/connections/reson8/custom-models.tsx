import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { FormContainer, FormField } from "@/components/backoffice";

import { createReson8CustomModel, fetchReson8Config, fetchReson8CustomModels } from "./data";
import { formatTimestamp, type Reson8LayoutContext } from "./shared";

type Reson8CustomModelsActionData = {
  ok: boolean;
  message: string;
};

type Reson8CustomModelForm = {
  name: string;
  description: string;
  phrases: string;
};

const normalizeCustomModelInput = (input: Reson8CustomModelForm) => {
  const name = input.name.trim();
  const description = input.description.trim();
  const phrases = input.phrases
    .split(/\r?\n/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);

  if (!name) {
    return { ok: false as const, message: "Model name is required." };
  }

  if (!description) {
    return { ok: false as const, message: "Model description is required." };
  }

  if (phrases.length === 0) {
    return { ok: false as const, message: "Add at least one phrase." };
  }

  return {
    ok: true as const,
    payload: {
      name,
      description,
      phrases,
    },
  };
};

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchReson8Config(context, orgId);
  if (configError) {
    return {
      configError,
      modelsError: null,
      models: [],
    };
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/reson8/${orgId}/configuration`);
  }

  const { models, modelsError } = await fetchReson8CustomModels(request, context, orgId);
  return {
    configError: null,
    modelsError,
    models,
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const payload = {
    name: typeof formData.get("name") === "string" ? String(formData.get("name")) : "",
    description:
      typeof formData.get("description") === "string" ? String(formData.get("description")) : "",
    phrases: typeof formData.get("phrases") === "string" ? String(formData.get("phrases")) : "",
  } satisfies Reson8CustomModelForm;

  const validation = normalizeCustomModelInput(payload);
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
    } satisfies Reson8CustomModelsActionData;
  }

  const result = await createReson8CustomModel(request, context, orgId, validation.payload);
  if (result.error) {
    return {
      ok: false,
      message: result.error,
    } satisfies Reson8CustomModelsActionData;
  }

  return {
    ok: true,
    message: `Created model '${validation.payload.name}'.`,
  } satisfies Reson8CustomModelsActionData;
}

export default function BackofficeOrganisationReson8CustomModels() {
  const { models, configError, modelsError } = useLoaderData<typeof loader>();
  const { configState } = useOutletContext<Reson8LayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [localError, setLocalError] = useState<string | null>(null);
  const [formState, setFormState] = useState<Reson8CustomModelForm>({
    name: "",
    description: "",
    phrases: "",
  });

  useEffect(() => {
    if (!actionData?.ok) {
      return;
    }

    setFormState({
      name: "",
      description: "",
      phrases: "",
    });
  }, [actionData]);

  const summary = useMemo(
    () => ({
      totalModels: models.length,
      totalPhrases: models.reduce((total, model) => total + model.phraseCount, 0),
    }),
    [models],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);

    const validation = normalizeCustomModelInput(formState);
    if (!validation.ok) {
      setLocalError(validation.message);
      event.preventDefault();
    }
  };

  const createError = localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const createSuccess = !localError && actionData?.ok ? actionData.message : null;

  if (configError) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
        {configError}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Library
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Custom models</h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Curate domain-specific phrase lists so prerecorded and realtime transcription can
                use the same vocabulary.
              </p>
            </div>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {summary.totalModels} total
            </span>
          </div>

          <div className="mt-4 grid gap-3 text-sm text-[var(--bo-muted)] md:grid-cols-3">
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Models
              </p>
              <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                {summary.totalModels}
              </p>
            </div>
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Tracked phrases
              </p>
              <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                {summary.totalPhrases}
              </p>
            </div>
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Updated
              </p>
              <p className="mt-2 text-sm text-[var(--bo-fg)]">
                {formatTimestamp(configState?.config?.updatedAt) || "—"}
              </p>
            </div>
          </div>
        </div>

        <FormContainer
          title="Create a model"
          eyebrow="Write once"
          description="Each line becomes a phrase Reson8 can bias toward during recognition."
        >
          <Form method="post" onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-4">
              <FormField
                label="Model name"
                hint="Human-readable label used throughout the backoffice."
              >
                <input
                  type="text"
                  name="name"
                  value={formState.name}
                  onChange={(event) => {
                    setLocalError(null);
                    setFormState((prev) => ({ ...prev, name: event.target.value }));
                  }}
                  placeholder="Clinical intake"
                  className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                />
              </FormField>

              <FormField
                label="Description"
                hint="Explain where this vocabulary is intended to be used."
              >
                <textarea
                  name="description"
                  rows={3}
                  value={formState.description}
                  onChange={(event) => {
                    setLocalError(null);
                    setFormState((prev) => ({ ...prev, description: event.target.value }));
                  }}
                  placeholder="Terms commonly used during patient intake calls."
                  className="w-full resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                />
              </FormField>

              <FormField label="Phrases" hint="One phrase per line.">
                <textarea
                  name="phrases"
                  rows={8}
                  value={formState.phrases}
                  onChange={(event) => {
                    setLocalError(null);
                    setFormState((prev) => ({ ...prev, phrases: event.target.value }));
                  }}
                  placeholder={
                    "myocardial infarction\natrial fibrillation\nnon-invasive ventilation"
                  }
                  className="w-full resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                />
              </FormField>
            </div>

            {createError ? <p className="text-xs text-red-500">{createError}</p> : null}
            {createSuccess ? <p className="text-xs text-green-500">{createSuccess}</p> : null}

            <button
              type="submit"
              disabled={saving}
              className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
            >
              {saving ? "Creating…" : "Create custom model"}
            </button>
          </Form>
        </FormContainer>
      </section>

      {modelsError ? (
        <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          {modelsError}
        </div>
      ) : models.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No custom models yet. Create one to bias transcription toward recurring names, jargon, and
          product language.
        </div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {models.map((model) => (
            <article
              key={model.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    {model.id}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">{model.name}</h3>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                  {model.phraseCount} phrases
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[var(--bo-muted)]">{model.description}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
