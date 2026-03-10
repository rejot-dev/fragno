import { useEffect, useState, type FormEvent } from "react";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import { FormContainer, FormField } from "@/components/backoffice";
import { getPiDurableObject } from "@/cloudflare/cloudflare-utils";
import type { Route } from "./+types/configuration";
import { formatTimestamp, type PiLayoutContext } from "./shared";
import { getAuthMe } from "@/fragno/auth-server";
import type { PiConfigState } from "@/fragno/pi-shared";

type PiConfigForm = {
  openaiKey: string;
  anthropicKey: string;
  geminiKey: string;
};

type PiConfigActionData = {
  ok: boolean;
  message: string;
  configState?: PiConfigState;
};

export async function action({ request, context, params }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return {
      ok: false,
      message: "Authentication required.",
    } satisfies PiConfigActionData;
  }

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };

  const openaiKey = getValue("openaiKey");
  const anthropicKey = getValue("anthropicKey");
  const geminiKey = getValue("geminiKey");

  if (!openaiKey && !anthropicKey && !geminiKey) {
    return {
      ok: false,
      message: "Provide at least one API key to update configuration.",
    } satisfies PiConfigActionData;
  }

  const apiKeys: Record<string, string> = {};
  if (openaiKey) {
    apiKeys.openai = openaiKey;
  }
  if (anthropicKey) {
    apiKeys.anthropic = anthropicKey;
  }
  if (geminiKey) {
    apiKeys.gemini = geminiKey;
  }

  const piDo = getPiDurableObject(context, params.orgId);

  try {
    const configState = await piDo.setAdminConfig({ apiKeys });
    return {
      ok: true,
      message: "Pi API keys saved.",
      configState,
    } satisfies PiConfigActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies PiConfigActionData;
  }
}

export default function BackofficeOrganisationPiConfiguration() {
  const { configState, configLoading, configError, setConfigState, setConfigError } =
    useOutletContext<PiLayoutContext>();
  const actionData = useActionData<PiConfigActionData>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [localError, setLocalError] = useState<string | null>(null);
  const [formState, setFormState] = useState<PiConfigForm>({
    openaiKey: "",
    anthropicKey: "",
    geminiKey: "",
  });

  useEffect(() => {
    if (!actionData?.configState) {
      return;
    }
    setConfigState(actionData.configState);
    setConfigError(null);
    if (actionData.ok) {
      setFormState({ openaiKey: "", anthropicKey: "", geminiKey: "" });
    }
  }, [actionData, setConfigError, setConfigState]);

  const saveError = localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const saveSuccess = !localError && actionData && actionData.ok ? actionData.message : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);
    if (!formState.openaiKey && !formState.anthropicKey && !formState.geminiKey) {
      setLocalError("Provide at least one API key.");
      event.preventDefault();
    }
  };

  const statusLabel = configState?.configured ? "Configured" : "Not configured";
  const statusTone = configState?.configured
    ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
    : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";

  const config = configState?.config;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Status
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Pi runtime</h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Each organisation gets a dedicated Pi fragment and workflow engine hosted in a
                Durable Object.
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
            ) : config ? (
              <>
                <p>
                  OpenAI key:{" "}
                  <span className="text-[var(--bo-fg)]">{config.apiKeys.openai ?? "—"}</span>
                </p>
                <p>
                  Anthropic key:{" "}
                  <span className="text-[var(--bo-fg)]">{config.apiKeys.anthropic ?? "—"}</span>
                </p>
                <p>
                  Gemini key:{" "}
                  <span className="text-[var(--bo-fg)]">{config.apiKeys.gemini ?? "—"}</span>
                </p>
                <p>
                  Harnesses: <span className="text-[var(--bo-fg)]">{config.harnesses.length}</span>
                </p>
                <p>
                  Last updated:{" "}
                  <span className="text-[var(--bo-fg)]">{formatTimestamp(config.updatedAt)}</span>
                </p>
              </>
            ) : (
              <p>Store API keys to enable Pi sessions.</p>
            )}
          </div>
        </div>

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">Notes</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Key management</h2>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            API keys are stored per organisation and never displayed in full after save. Provide a
            new key to rotate credentials.
          </p>
          <p className="mt-4 text-xs text-[var(--bo-muted-2)]">
            Harnesses are configured separately and surfaced in the Harnesses tab. If none are
            configured, a built-in Default harness with bash access is used.
          </p>
        </div>
      </section>

      <FormContainer
        title="API keys"
        eyebrow="Configuration"
        description="Store provider credentials for this organisation."
      >
        <Form method="post" onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="OpenAI API key" hint="Required for GPT models.">
              <input
                type="password"
                name="openaiKey"
                value={formState.openaiKey}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({ ...prev, openaiKey: event.target.value }));
                }}
                placeholder="sk-..."
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Anthropic API key" hint="Required for Claude models.">
              <input
                type="password"
                name="anthropicKey"
                value={formState.anthropicKey}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({ ...prev, anthropicKey: event.target.value }));
                }}
                placeholder="sk-ant-..."
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>

            <FormField label="Gemini API key" hint="Required for Gemini preview models.">
              <input
                type="password"
                name="geminiKey"
                value={formState.geminiKey}
                onChange={(event) => {
                  setLocalError(null);
                  setFormState((prev) => ({ ...prev, geminiKey: event.target.value }));
                }}
                placeholder="AIza..."
                className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
              />
            </FormField>
          </div>

          {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
          {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

          <button
            type="submit"
            disabled={saving}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save API keys"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}
