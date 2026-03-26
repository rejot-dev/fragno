import { useEffect, useState, type FormEvent } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useOutletContext,
  type ActionFunctionArgs,
} from "react-router";

import { getReson8DurableObject } from "@/cloudflare/cloudflare-utils";
import { FormContainer, FormField } from "@/components/backoffice";

import { formatTimestamp, type Reson8ConfigState, type Reson8LayoutContext } from "./shared";

type Reson8ConfigForm = {
  apiKey: string;
};

type Reson8ConfigActionData = {
  ok: boolean;
  message: string;
  configState?: Reson8ConfigState;
};

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const apiKey = typeof formData.get("apiKey") === "string" ? String(formData.get("apiKey")) : "";

  const reson8Do = getReson8DurableObject(context, params.orgId);

  try {
    const configState = await reson8Do.setAdminConfig({ apiKey }, params.orgId);
    return {
      ok: true,
      message: "Reson8 API key saved.",
      configState,
    } satisfies Reson8ConfigActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies Reson8ConfigActionData;
  }
}

export default function BackofficeOrganisationReson8Configuration() {
  const { configState, configLoading, configError, setConfigState, setConfigError } =
    useOutletContext<Reson8LayoutContext>();
  const [localError, setLocalError] = useState<string | null>(null);
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [formState, setFormState] = useState<Reson8ConfigForm>({
    apiKey: "",
  });

  const isConfigured = Boolean(configState?.configured);

  useEffect(() => {
    if (!actionData?.configState) {
      return;
    }

    setConfigState(actionData.configState);
    setConfigError(null);
    if (actionData.ok) {
      setFormState({ apiKey: "" });
    }
  }, [actionData, setConfigError, setConfigState]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);

    if (!isConfigured && !formState.apiKey.trim()) {
      setLocalError("Reson8 API key is required.");
      event.preventDefault();
    }
  };

  const saveError = localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const saveSuccess = !localError && actionData?.ok ? actionData.message : null;

  const statusLabel = isConfigured ? "Configured" : "Not configured";
  const statusTone = isConfigured
    ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
    : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";

  return (
    <div className="space-y-4">
      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Status
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Reson8 connection</h2>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">
              Store one API key for this organisation. That key is used for auth tokens, custom
              models, prerecorded transcription, and realtime speech.
            </p>
          </div>
          <span
            className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${statusTone}`}
          >
            {statusLabel}
          </span>
        </div>

        <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
          {configLoading ? (
            <p>Loading configuration…</p>
          ) : configError ? (
            <p className="text-red-500">{configError}</p>
          ) : isConfigured ? (
            <>
              <p>
                API key:{" "}
                <span className="text-[var(--bo-fg)]">{configState?.config?.apiKeyPreview}</span>
              </p>
              <p>
                Last updated:{" "}
                <span className="text-[var(--bo-fg)]">
                  {formatTimestamp(configState?.config?.updatedAt)}
                </span>
              </p>
            </>
          ) : (
            <p>Add a Reson8 API key to enable transcription and custom model management.</p>
          )}
        </div>
      </section>

      <FormContainer
        title="Reson8 API key"
        eyebrow="Configuration"
        description="Save the API key for this organisation. Leave it blank later if you want to keep the existing key."
      >
        <Form method="post" onSubmit={handleSubmit} className="space-y-4">
          <FormField
            label="Reson8 API key"
            hint={
              isConfigured
                ? "Leave blank to keep the current API key."
                : "Required before you can use Reson8."
            }
          >
            <input
              type="password"
              name="apiKey"
              value={formState.apiKey}
              onChange={(event) => {
                setLocalError(null);
                setFormState({ apiKey: event.target.value });
              }}
              placeholder="rs8_..."
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
            />
          </FormField>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <button
            type="submit"
            disabled={saving}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Reson8 API key"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
