import { useEffect, useState, type FormEvent } from "react";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";

import { getOtpDurableObject, getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";
import { FormContainer, FormField, WizardStepper } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth-server";

import type { Route } from "./+types/configuration";
import {
  formatTimestamp,
  generateSecretToken,
  type TelegramConfigState,
  type TelegramLayoutContext,
} from "./shared";

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

type TelegramLinkIssue = {
  startToken: string;
  startCommand: string;
  deepLink: string | null;
};

type TelegramConfigActionData = {
  ok: boolean;
  intent: "save-config" | "issue-link";
  message: string;
  configState?: TelegramConfigState;
  linkIssue?: TelegramLinkIssue;
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
  const intent = getValue("intent") === "issue-link" ? "issue-link" : "save-config";

  if (intent === "issue-link") {
    const me = await getAuthMe(request, context);
    if (!me?.user) {
      throw new Response("Unauthorized", { status: 401 });
    }

    try {
      const telegramDo = getTelegramDurableObject(context, params.orgId);
      const configState = await telegramDo.getAdminConfig();
      if (!configState.configured) {
        return {
          ok: false,
          intent,
          message: "Configure Telegram before generating a link.",
        } satisfies TelegramConfigActionData;
      }

      const otpDo = getOtpDurableObject(context, params.orgId);
      const issued = await otpDo.issueTelegramLinkOtp({
        userId: me.user.id,
      });

      const botUsername = configState.config?.botUsername?.replace(/^@/, "") ?? null;
      const startCommand = `/start ${issued.startToken}`;
      const deepLink = botUsername
        ? `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(issued.startToken)}`
        : null;

      return {
        ok: true,
        intent,
        message: "Telegram link generated.",
        linkIssue: {
          startToken: issued.startToken,
          startCommand,
          deepLink,
        },
      } satisfies TelegramConfigActionData;
    } catch (error) {
      return {
        ok: false,
        intent,
        message: error instanceof Error ? error.message : "Unable to generate a Telegram link.",
      } satisfies TelegramConfigActionData;
    }
  }

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
      intent,
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
        intent,
        message: webhook.message,
        configState,
      } satisfies TelegramConfigActionData;
    }

    return {
      ok: true,
      intent,
      message: webhook?.message ?? "Telegram credentials saved.",
      configState,
    } satisfies TelegramConfigActionData;
  } catch (error) {
    return {
      ok: false,
      intent,
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
  const submittedIntent = navigation.formData?.get("intent");
  const saving = navigation.state === "submitting" && submittedIntent !== "issue-link";
  const generatingLink = navigation.state === "submitting" && submittedIntent === "issue-link";
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
    if (actionData?.intent !== "save-config" || !actionData.configState) {
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

  const saveError =
    localError ??
    (actionData?.intent === "save-config" && !actionData.ok ? actionData.message : null);
  const saveSuccess =
    !localError && actionData?.intent === "save-config" && actionData.ok
      ? actionData.message
      : null;
  const linkError =
    actionData?.intent === "issue-link" && !actionData.ok ? actionData.message : null;
  const linkIssue =
    actionData?.intent === "issue-link" && actionData.ok ? (actionData.linkIssue ?? null) : null;

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
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
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
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
              {webhookBaseUrlError ? (
                <p className="text-xs text-red-500">{webhookBaseUrlError}</p>
              ) : null}
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

      <FormContainer
        title="Link your Telegram account"
        eyebrow="Account linking"
        description="Generate a short-lived /start link for your currently signed-in backoffice user."
      >
        <div className="space-y-4">
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
            <p>
              Use this when you want to connect your Telegram chatter identity to your backoffice
              user for this organisation.
            </p>
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
              Generating a new link invalidates any earlier unused link for your account.
            </p>
          </div>

          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="issue-link" />
            <button
              type="submit"
              disabled={!configState?.configured || generatingLink}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generatingLink ? "Generating…" : "Generate Telegram link"}
            </button>
          </Form>

          {linkError ? <p className="text-xs text-red-500">{linkError}</p> : null}

          {linkIssue ? (
            <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              <div>
                <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Start command
                </p>
                <p className="mt-2 font-mono break-all text-[var(--bo-fg)]">
                  {linkIssue.startCommand}
                </p>
              </div>

              {linkIssue.deepLink ? (
                <div>
                  <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Deep link
                  </p>
                  <a
                    href={linkIssue.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-fg)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)]"
                  >
                    Open Telegram
                  </a>
                  <p className="mt-2 text-xs break-all text-[var(--bo-muted-2)]">
                    {linkIssue.deepLink}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </FormContainer>
    </div>
  );
}
