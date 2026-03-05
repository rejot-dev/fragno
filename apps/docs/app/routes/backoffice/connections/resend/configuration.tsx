import { useEffect, useState } from "react";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import { FormContainer, FormField, WizardStepper } from "@/components/backoffice";
import { getResendDurableObject } from "@/cloudflare/cloudflare-utils";
import { formatTimestamp, type ResendConfigState, type ResendLayoutContext } from "./shared";
import type { Route } from "./+types/configuration";

const SETUP_STEPS = [
  {
    title: "Create API key",
    description: "Generate a Resend API key with access to email + webhook management.",
    helper: "Resend dashboard → API keys",
  },
  {
    title: "Register webhook",
    description: "We will create or update a webhook to receive delivery events.",
    helper: "Events: sent, delivered, bounced, opened, clicked",
  },
  {
    title: "Save defaults",
    description: "Store the API key and default sender details for this organisation.",
    helper: "Saved per organisation",
  },
];

type ResendConfigForm = {
  apiKey: string;
  defaultFrom: string;
  defaultReplyTo: string;
  webhookBaseUrl: string;
};

type ResendConfigActionData = {
  ok: boolean;
  message: string;
  configState?: ResendConfigState;
};

type ResendConfigValidationResult =
  | { ok: true; payload: ResendConfigForm }
  | { ok: false; message: string };

const isValidHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const validateOptionalUrl = (value: string, label: string) => {
  if (!value) {
    return null;
  }
  if (!isValidHttpUrl(value)) {
    return `${label} must include http:// or https://.`;
  }
  return null;
};

const normalizeResendConfigInput = (input: ResendConfigForm): ResendConfigValidationResult => {
  const apiKey = input.apiKey.trim();
  const defaultFrom = input.defaultFrom.trim();
  const defaultReplyTo = input.defaultReplyTo.trim();
  const webhookBaseUrl = input.webhookBaseUrl.trim();

  const webhookBaseUrlError = validateOptionalUrl(webhookBaseUrl, "Webhook base URL");
  if (webhookBaseUrlError) {
    return { ok: false, message: webhookBaseUrlError };
  }

  return {
    ok: true,
    payload: {
      apiKey,
      defaultFrom,
      defaultReplyTo,
      webhookBaseUrl,
    },
  };
};

export async function action({ request, context, params }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };

  const payload = {
    apiKey: getValue("apiKey"),
    defaultFrom: getValue("defaultFrom"),
    defaultReplyTo: getValue("defaultReplyTo"),
    webhookBaseUrl: getValue("webhookBaseUrl"),
  };

  const validation = normalizeResendConfigInput(payload);
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
    } satisfies ResendConfigActionData;
  }

  const origin = new URL(request.url).origin;
  const resendDo = getResendDurableObject(context, params.orgId);

  try {
    const configState = await resendDo.setAdminConfig(validation.payload, params.orgId, origin);
    const webhook = configState.webhook;
    if (webhook && !webhook.ok) {
      return {
        ok: false,
        message: webhook.message,
        configState,
      } satisfies ResendConfigActionData;
    }

    return {
      ok: true,
      message: webhook?.message ?? "Resend credentials saved.",
      configState,
    } satisfies ResendConfigActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies ResendConfigActionData;
  }
}

export default function BackofficeOrganisationResendConfiguration() {
  const { orgId, origin, configState, configLoading, configError, setConfigState, setConfigError } =
    useOutletContext<ResendLayoutContext>();
  const [currentStep, setCurrentStep] = useState(0);
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [formState, setFormState] = useState<ResendConfigForm>({
    apiKey: "",
    defaultFrom: "",
    defaultReplyTo: "",
    webhookBaseUrl: "",
  });

  const isConfigured = Boolean(configState?.configured);
  const webhookBaseUrl = formState.webhookBaseUrl.trim() || origin;
  const webhookUrl = `${webhookBaseUrl.replace(/\/+$/, "")}/api/resend/${orgId}/resend/webhook`;
  const webhookBaseUrlError = validateOptionalUrl(
    formState.webhookBaseUrl.trim(),
    "Webhook base URL",
  );

  useEffect(() => {
    if (!configState?.configured || !configState.config) {
      return;
    }

    setCurrentStep(2);
    setFormState((prev) => ({
      ...prev,
      defaultFrom: prev.defaultFrom || configState.config?.defaultFrom || "",
      defaultReplyTo: prev.defaultReplyTo || configState.config?.defaultReplyTo?.join(", ") || "",
      webhookBaseUrl: prev.webhookBaseUrl || configState.config?.webhookBaseUrl || "",
    }));
  }, [configState]);

  useEffect(() => {
    if (!actionData?.configState) {
      return;
    }
    setConfigState(actionData.configState);
    setConfigError(null);
    if (actionData.ok) {
      setFormState((prev) => ({
        ...prev,
        apiKey: "",
      }));
    }
  }, [actionData, setConfigError, setConfigState]);

  const saveError = actionData && !actionData.ok ? actionData.message : null;
  const saveSuccess = actionData && actionData.ok ? actionData.message : null;

  const statusLabel = configState?.configured ? "Configured" : "Not configured";
  const statusTone = configState?.configured
    ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
    : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";

  return (
    <div className="space-y-4">
      <section className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Status
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Resend connection</h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Each organisation gets its own Resend fragment instance and delivery tracking.
              </p>
            </div>
            <span
              className={`border px-2 py-1 text-[10px] uppercase tracking-[0.22em] ${statusTone}`}
            >
              {statusLabel}
            </span>
          </div>

          <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
            {configLoading ? (
              <p>Loading configuration…</p>
            ) : configError ? (
              <p className="text-red-500">{configError}</p>
            ) : configState?.configured ? (
              <>
                <p>
                  Default from:{" "}
                  <span className="text-[var(--bo-fg)]">{configState.config?.defaultFrom}</span>
                </p>
                <p>
                  Last updated:{" "}
                  <span className="text-[var(--bo-fg)]">
                    {formatTimestamp(configState.config?.updatedAt)}
                  </span>
                </p>
                {configState.config?.webhookBaseUrl ? (
                  <p>
                    Webhook base URL:{" "}
                    <span className="text-[var(--bo-fg)]">{configState.config.webhookBaseUrl}</span>
                  </p>
                ) : null}
                {configState.config?.webhookId ? (
                  <p>
                    Webhook ID:{" "}
                    <span className="text-[var(--bo-fg)]">{configState.config.webhookId}</span>
                  </p>
                ) : null}
                {configState.config?.apiKeyPreview ? (
                  <p>
                    API key:{" "}
                    <span className="text-[var(--bo-fg)]">{configState.config.apiKeyPreview}</span>
                  </p>
                ) : null}
                {configState.config?.webhookSecretPreview ? (
                  <p>
                    Signing secret:{" "}
                    <span className="text-[var(--bo-fg)]">
                      {configState.config.webhookSecretPreview}
                    </span>
                  </p>
                ) : null}
              </>
            ) : (
              <p>Connect Resend to start tracking delivery events.</p>
            )}
          </div>
        </div>

        <FormContainer
          title="Setup wizard"
          eyebrow="Step-by-step"
          description="Collect the API key and register the webhook."
        >
          <WizardStepper
            steps={SETUP_STEPS}
            currentStep={currentStep}
            onStepChange={setCurrentStep}
          />
        </FormContainer>
      </section>

      <FormContainer
        title="Resend credentials"
        eyebrow="Configuration"
        description="Store API credentials for this organisation. API keys are never displayed after save."
      >
        <Form method="post" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label="Resend API key"
              hint={
                isConfigured
                  ? "Leave blank to keep the current API key."
                  : "Generate in the Resend dashboard. Required on first setup."
              }
            >
              <input
                type="password"
                name="apiKey"
                value={formState.apiKey}
                onChange={(event) => {
                  setFormState((prev) => ({
                    ...prev,
                    apiKey: event.target.value,
                  }));
                }}
                placeholder="re_..."
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField
              label="Default from"
              hint={
                isConfigured
                  ? "Update the default sender as needed."
                  : "Required. Matches your verified Resend domain."
              }
            >
              <input
                type="text"
                name="defaultFrom"
                value={formState.defaultFrom}
                onChange={(event) => {
                  setFormState((prev) => ({
                    ...prev,
                    defaultFrom: event.target.value,
                  }));
                }}
                placeholder="Fragno <hello@example.com>"
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Default reply-to" hint="Optional. Comma-separated list.">
              <input
                type="text"
                name="defaultReplyTo"
                value={formState.defaultReplyTo}
                onChange={(event) => {
                  setFormState((prev) => ({
                    ...prev,
                    defaultReplyTo: event.target.value,
                  }));
                }}
                placeholder="support@example.com"
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Webhook base URL" hint="Optional. Use a tunnel URL when developing.">
              <input
                type="url"
                name="webhookBaseUrl"
                value={formState.webhookBaseUrl}
                onChange={(event) => {
                  setFormState((prev) => ({
                    ...prev,
                    webhookBaseUrl: event.target.value,
                  }));
                }}
                placeholder={origin}
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
              {webhookBaseUrlError ? (
                <p className="text-xs text-red-500">{webhookBaseUrlError}</p>
              ) : null}
            </FormField>
          </div>

          <div className="space-y-3">
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                Webhook URL
              </p>
              <p className="mt-2 break-all text-[var(--bo-fg)]">{webhookUrl}</p>
              <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                Resend webhooks will be registered automatically when you save this configuration.
              </p>
            </div>
          </div>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <button
            type="submit"
            disabled={saving}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Resend config"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
