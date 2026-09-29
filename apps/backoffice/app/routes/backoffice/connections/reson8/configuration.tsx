import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useEffect, useState, type SubmitEvent } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useOutletContext,
  type ActionFunctionArgs,
} from "react-router";

import { getReson8DurableObject } from "@/worker-runtime/durable-objects";

import { resolveAuthenticatedOrgIntegrationContext } from "../../integrations/scope";
import { formatTimestamp } from "../formatting";
import type { Reson8ConfigState, Reson8LayoutContext } from "./shared";

type Reson8ConfigForm = {
  apiKey: string;
};

type Reson8ConfigActionData = {
  ok: boolean;
  message: string;
  configState?: Reson8ConfigState;
};

export async function action({ request, context, params }: ActionFunctionArgs) {
  const { orgId } = await resolveAuthenticatedOrgIntegrationContext({
    request,
    context,
    params,
    integration: "reson8",
  });

  const formData = await request.formData();
  const apiKey = typeof formData.get("apiKey") === "string" ? String(formData.get("apiKey")) : "";

  const reson8Do = getReson8DurableObject(context, orgId);

  try {
    const configState = await reson8Do.commands.setAdminConfig({ apiKey }, orgId);
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

export default function BackofficeOrganizationReson8Configuration() {
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

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
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
              Store one API key for this organization. That key is used for auth tokens, custom
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
        description="Save the API key for this organization. Leave it blank later if you want to keep the existing key."
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
            <Input
              type="password"
              name="apiKey"
              value={formState.apiKey}
              onChange={(event) => {
                setLocalError(null);
                setFormState({ apiKey: event.target.value });
              }}
              placeholder="rs8_..."
              className="w-full"
            />
          </FormField>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <Button variant="accent" type="submit" disabled={saving} className="w-full">
            {saving ? "Saving…" : "Save Reson8 API key"}
          </Button>
        </Form>
      </FormContainer>
    </div>
  );
}
