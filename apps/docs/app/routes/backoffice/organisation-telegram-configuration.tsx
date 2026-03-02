import { useEffect, useState, type FormEvent } from "react";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import { FormContainer, FormField, WizardStepper } from "@/components/backoffice";
import { getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";
import {
  formatTimestamp,
  generateSecretToken,
  type TelegramConfigState,
  type TelegramLayoutContext,
} from "./organisation-telegram-shared";
import type { Route } from "./+types/organisation-telegram-configuration";

const SETUP_STEPS = [
  {
    title: "Create a bot",
    description:
      "Use BotFather in Telegram to create a bot, set its name, and copy the bot token + username.",
    helper: "BotFather: /newbot",
  },
  {
    title: "Configure webhook",
    description:
      "Generate a webhook secret, then register the webhook URL with Telegram so updates flow in.",
    helper: "setWebhook with secret_token",
  },
  {
    title: "Store credentials",
    description:
      "Save the bot token and secret for this organisation. The fragment will start ingesting chats.",
    helper: "Saved per organisation",
  },
];

type TelegramConfigForm = {
  botToken: string;
  webhookSecretToken: string;
  botUsername: string;
  apiBaseUrl: string;
  webhookBaseUrl: string;
};

type TelegramConfigActionData = {
  ok: boolean;
  message: string;
  configState?: TelegramConfigState;
};

type TelegramConfigValidationResult =
  | { ok: true; payload: TelegramConfigForm }
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

const normalizeTelegramConfigInput = (
  input: TelegramConfigForm,
): TelegramConfigValidationResult => {
  const botToken = input.botToken.trim();
  const webhookSecretToken = input.webhookSecretToken.trim();
  const botUsername = input.botUsername.trim().replace(/^@/, "");
  const apiBaseUrl = input.apiBaseUrl.trim();
  const webhookBaseUrl = input.webhookBaseUrl.trim();

  if (!botToken || !webhookSecretToken) {
    return { ok: false, message: "Bot token and webhook secret token are required." };
  }

  const apiBaseUrlError = validateOptionalUrl(apiBaseUrl, "API base URL");
  if (apiBaseUrlError) {
    return { ok: false, message: apiBaseUrlError };
  }

  const webhookBaseUrlError = validateOptionalUrl(webhookBaseUrl, "Webhook base URL");
  if (webhookBaseUrlError) {
    return { ok: false, message: webhookBaseUrlError };
  }

  return {
    ok: true,
    payload: {
      botToken,
      webhookSecretToken,
      botUsername,
      apiBaseUrl,
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
    botToken: getValue("botToken"),
    webhookSecretToken: getValue("webhookSecretToken"),
    botUsername: getValue("botUsername"),
    apiBaseUrl: getValue("apiBaseUrl"),
    webhookBaseUrl: getValue("webhookBaseUrl"),
  };

  const validation = normalizeTelegramConfigInput(payload);
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
    } satisfies TelegramConfigActionData;
  }

  const origin = new URL(request.url).origin;
  const telegramDo = getTelegramDurableObject(context, params.orgId);

  try {
    const configState = await telegramDo.setAdminConfig(validation.payload, params.orgId, origin);
    const webhook = configState.webhook;
    if (webhook && !webhook.ok) {
      return {
        ok: false,
        message: webhook.message,
        configState,
      } satisfies TelegramConfigActionData;
    }

    return {
      ok: true,
      message: webhook?.message ?? "Telegram credentials saved.",
      configState,
    } satisfies TelegramConfigActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies TelegramConfigActionData;
  }
}

export default function BackofficeOrganisationTelegramConfiguration() {
  const { orgId, origin, configState, configLoading, configError, setConfigState, setConfigError } =
    useOutletContext<TelegramLayoutContext>();
  const [currentStep, setCurrentStep] = useState(0);
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [localError, setLocalError] = useState<string | null>(null);
  const [formState, setFormState] = useState<TelegramConfigForm>({
    botToken: "",
    webhookSecretToken: "",
    botUsername: "",
    apiBaseUrl: "",
    webhookBaseUrl: "",
  });

  const webhookBaseUrl = formState.webhookBaseUrl.trim() || origin;
  const webhookUrl = `${webhookBaseUrl.replace(/\/+$/, "")}/api/telegram/${orgId}/telegram/webhook`;
  const apiBaseUrlError = validateOptionalUrl(formState.apiBaseUrl.trim(), "API base URL");
  const webhookBaseUrlError = validateOptionalUrl(
    formState.webhookBaseUrl.trim(),
    "Webhook base URL",
  );
  const botTokenPlaceholder = formState.botToken
    ? "<REDACTED_BOT_TOKEN>"
    : "<BOT_TOKEN_FROM_BOTFATHER>";
  const webhookSecretPlaceholder = formState.webhookSecretToken
    ? "<REDACTED_WEBHOOK_SECRET>"
    : "<WEBHOOK_SECRET_TOKEN>";
  const webhookCommand = `curl -X POST "https://api.telegram.org/bot${botTokenPlaceholder}/setWebhook" \\\n  -d "url=${webhookUrl}" \\\n  -d "secret_token=${webhookSecretPlaceholder}"`;

  useEffect(() => {
    if (!configState?.configured || !configState.config) {
      return;
    }

    setCurrentStep(2);
    setFormState((prev) => ({
      ...prev,
      botUsername: prev.botUsername || configState.config?.botUsername || "",
      apiBaseUrl: prev.apiBaseUrl || configState.config?.apiBaseUrl || "",
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
        botToken: "",
        webhookSecretToken: "",
      }));
    }
  }, [actionData, setConfigError, setConfigState]);

  const saveError = localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const saveSuccess = !localError && actionData && actionData.ok ? actionData.message : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);

    const validation = normalizeTelegramConfigInput(formState);
    if (!validation.ok) {
      setLocalError(validation.message);
      event.preventDefault();
    }
  };

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
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                Telegram connection
              </h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Each organisation gets a dedicated Telegram fragment instance and database.
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
                  Bot username:{" "}
                  <span className="text-[var(--bo-fg)]">
                    @{configState.config?.botUsername ?? "unknown"}
                  </span>
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
                {configState.config?.botTokenPreview ? (
                  <p>
                    Bot token:{" "}
                    <span className="text-[var(--bo-fg)]">
                      {configState.config.botTokenPreview}
                    </span>
                  </p>
                ) : null}
                {configState.config?.webhookSecretTokenPreview ? (
                  <p>
                    Secret token:{" "}
                    <span className="text-[var(--bo-fg)]">
                      {configState.config.webhookSecretTokenPreview}
                    </span>
                  </p>
                ) : null}
              </>
            ) : (
              <p>Connect a bot to start collecting chat activity.</p>
            )}
          </div>
        </div>

        <FormContainer
          title="Setup wizard"
          eyebrow="Step-by-step"
          description="Collect the bot credentials and register the webhook."
        >
          <WizardStepper
            steps={SETUP_STEPS}
            currentStep={currentStep}
            onStepChange={setCurrentStep}
          />
        </FormContainer>
      </section>

      <FormContainer
        title="Telegram credentials"
        eyebrow="Configuration"
        description="Store bot credentials for this organisation. Tokens are never displayed after save."
        actions={
          <button
            type="button"
            onClick={() =>
              setFormState((prev) => ({ ...prev, webhookSecretToken: generateSecretToken() }))
            }
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Generate secret
          </button>
        }
      >
        <Form method="post" onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Bot token" hint="Copy from BotFather. Required.">
              <input
                type="password"
                name="botToken"
                value={formState.botToken}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({
                    ...prev,
                    botToken: event.target.value,
                  }));
                }}
                placeholder="123456:ABC-DEF1234ghIkl"
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Webhook secret token" hint="Used to verify Telegram webhooks.">
              <input
                type="password"
                name="webhookSecretToken"
                value={formState.webhookSecretToken}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({
                    ...prev,
                    webhookSecretToken: event.target.value,
                  }));
                }}
                placeholder="tg_..."
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Bot username" hint="Optional, used for display.">
              <input
                type="text"
                name="botUsername"
                value={formState.botUsername}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({
                    ...prev,
                    botUsername: event.target.value,
                  }));
                }}
                placeholder="my_bot"
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="API base URL" hint="Leave empty for api.telegram.org.">
              <input
                type="url"
                name="apiBaseUrl"
                value={formState.apiBaseUrl}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({
                    ...prev,
                    apiBaseUrl: event.target.value,
                  }));
                }}
                placeholder="https://api.telegram.org"
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
              {apiBaseUrlError ? <p className="text-xs text-red-500">{apiBaseUrlError}</p> : null}
            </FormField>

            <FormField label="Webhook base URL" hint="Optional. Use a tunnel URL when developing.">
              <input
                type="url"
                name="webhookBaseUrl"
                value={formState.webhookBaseUrl}
                onChange={(event) => {
                  setLocalError(null);
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
                Telegram will include the{" "}
                <span className="font-semibold">X-Telegram-Bot-Api-Secret-Token</span> header when
                calling this URL.
              </p>
            </div>

            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
              <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                Webhook registration
              </p>
              <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--bo-fg)]">
                {webhookCommand}
              </pre>
            </div>
          </div>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <button
            type="submit"
            disabled={saving}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Telegram config"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
