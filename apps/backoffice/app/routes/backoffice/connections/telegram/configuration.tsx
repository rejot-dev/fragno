import { useEffect, useState, type SubmitEvent } from "react";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";

import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { FormContainer, FormField } from "@/components/backoffice";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { resolveAuthenticatedIntegrationContext } from "../../integrations/scope";
import type { Route } from "./+types/configuration";
import { generateSecretToken } from "./secret-token";
import type { TelegramConfigState, TelegramLayoutContext } from "./shared";

type TelegramConfigForm = {
  botToken: string;
  webhookSecretToken: string;
  botUsername: string;
  apiBaseUrl: string;
};

type TelegramConfigActionData = {
  ok: boolean;
  intent: "save-config";
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

  if (!botToken || !webhookSecretToken) {
    return {
      ok: false,
      message: "Bot token and webhook secret token are required.",
    };
  }

  const apiBaseUrlError = validateOptionalUrl(apiBaseUrl, "API base URL");
  if (apiBaseUrlError) {
    return { ok: false, message: apiBaseUrlError };
  }

  return {
    ok: true,
    payload: {
      botToken,
      webhookSecretToken,
      botUsername,
      apiBaseUrl,
    },
  };
};

export async function action({ request, context, params }: Route.ActionArgs) {
  const integration = await resolveAuthenticatedIntegrationContext({
    request,
    context,
    params,
    integration: "telegram",
  });
  const scope = integration.scope;

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };
  const intent = "save-config" as const;

  const payload = {
    botToken: getValue("botToken"),
    webhookSecretToken: getValue("webhookSecretToken"),
    botUsername: getValue("botUsername"),
    apiBaseUrl: getValue("apiBaseUrl"),
  };

  const validation = normalizeTelegramConfigInput(payload);
  if (!validation.ok) {
    return {
      ok: false,
      intent,
      message: validation.message,
    } satisfies TelegramConfigActionData;
  }

  const { runtime } = context.get(BackofficeWorkerContext);

  try {
    const telegramDo = runtime.objects.telegram.for(scope);
    const status = await telegramDo.setAdminConfig(validation.payload);

    if (status.webhook && !status.webhook.ok) {
      return {
        ok: false,
        intent,
        message: status.webhook.message,
      } satisfies TelegramConfigActionData;
    }

    return {
      ok: true,
      intent,
      message: status.webhook?.message ?? "Telegram credentials saved.",
    } satisfies TelegramConfigActionData;
  } catch (error) {
    return {
      ok: false,
      intent,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies TelegramConfigActionData;
  }
}

export default function BackofficeOrganizationTelegramConfiguration() {
  const { publicBaseUrl, generatedWebhookSecretToken, scope, configState, setConfigError } =
    useOutletContext<TelegramLayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [localError, setLocalError] = useState<string | null>(null);
  const [formState, setFormState] = useState<TelegramConfigForm>({
    botToken: "",
    webhookSecretToken: generatedWebhookSecretToken,
    botUsername: "",
    apiBaseUrl: "",
  });

  const telegramScopeSegment = backofficeContextScopeSinglePathSegment(scope);
  const webhookUrl = `${publicBaseUrl.replace(/\/+$/, "")}/api/telegram/${telegramScopeSegment}/telegram/webhook`;
  const apiBaseUrlError = validateOptionalUrl(formState.apiBaseUrl.trim(), "API base URL");
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

    setFormState((prev) => ({
      ...prev,
      botUsername: prev.botUsername || configState.config?.botUsername || "",
      apiBaseUrl: prev.apiBaseUrl || configState.config?.apiBaseUrl || "",
    }));
  }, [configState]);

  useEffect(() => {
    if (actionData?.intent !== "save-config") {
      return;
    }

    if (actionData.ok) {
      setConfigError(null);
      setFormState((prev) => ({
        ...prev,
        botToken: "",
        webhookSecretToken: "",
      }));
    }
  }, [actionData, setConfigError]);

  const saveError =
    localError ??
    (actionData?.intent === "save-config" && !actionData.ok ? actionData.message : null);
  const saveSuccess =
    !localError && actionData?.intent === "save-config" && actionData.ok
      ? actionData.message
      : null;

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    setLocalError(null);

    const validation = normalizeTelegramConfigInput(formState);
    if (!validation.ok) {
      setLocalError(validation.message);
      event.preventDefault();
    }
  };

  return (
    <div className="space-y-4">
      <FormContainer
        title="Telegram credentials"
        eyebrow="Configuration"
        description="Store bot credentials for this organization. Tokens are never displayed after save."
        actions={
          <button
            type="button"
            onClick={() => {
              setFormState((prev) => ({
                ...prev,
                webhookSecretToken: generateSecretToken(),
              }));
            }}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Generate secret
          </button>
        }
      >
        <Form method="post" onSubmit={handleSubmit} className="space-y-4">
          <input type="hidden" name="intent" value="save-config" />
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
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
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
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
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
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
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
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
              {apiBaseUrlError ? <p className="text-xs text-red-500">{apiBaseUrlError}</p> : null}
            </FormField>
          </div>

          <div className="space-y-3">
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
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
              <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Webhook registration
              </p>
              <pre className="mt-2 text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                {webhookCommand}
              </pre>
            </div>
          </div>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <button
            type="submit"
            disabled={saving}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Telegram config"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
