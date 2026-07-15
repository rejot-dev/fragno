import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";

import { FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  getGitHubDurableObject,
  getGitHubWebhookRouterDurableObject,
} from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import type { Route } from "./+types/oauth-callback";
import {
  completeGitHubOAuth,
  syncGitHubInstallation,
  type GitHubOAuthComplete,
  type GitHubOAuthInstallation,
} from "./data";

const getStringValue = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const isSafeBackofficeReturnTo = (value: string | null | undefined) =>
  Boolean(value?.startsWith("/backoffice/connections/github/"));

const restoreStatusRedirect = (returnTo: string, code: string, detail?: string) => {
  const url = new URL(returnTo, "https://backoffice.local");
  url.searchParams.set("installFlow", code);
  if (detail) {
    url.searchParams.set("installFlowDetail", detail.slice(0, 240));
  }
  return `${url.pathname}${url.search}`;
};

type LoaderData =
  | {
      ok: true;
      state: string;
      orgId: string;
      returnTo: string;
      claim: GitHubOAuthComplete;
    }
  | { ok: false; message: string; returnTo: string | null };

type ActionData = { ok: false; message: string };

const isCompletedOAuth = (value: unknown): value is GitHubOAuthComplete => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GitHubOAuthComplete>;
  return Boolean(
    typeof candidate.state === "string" &&
    candidate.githubUser &&
    typeof candidate.githubUser.login === "string" &&
    Array.isArray(candidate.installations),
  );
};

export async function loader({
  request,
  context,
  url: requestUrl,
}: Route.LoaderArgs): Promise<LoaderData | Response> {
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const completed = requestUrl.searchParams.get("completed") === "1";
  const githubError = requestUrl.searchParams.get("error")?.trim() ?? "";
  const githubErrorDescription = requestUrl.searchParams.get("error_description")?.trim() ?? "";

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${requestUrl.pathname}${requestUrl.search}`));
  }

  if (githubError) {
    return {
      ok: false,
      message: githubErrorDescription || `GitHub authorization failed: ${githubError}`,
      returnTo: null,
    };
  }
  if (!state || (!code && !completed)) {
    return {
      ok: false,
      message: "GitHub OAuth callback is missing state or code.",
      returnTo: null,
    };
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.resolveInstallationClaimState({
    state,
    userId: me.user.id,
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message, returnTo: null };
  }

  const memberEntry = me.organizations.find((entry) => entry.organization.id === resolved.orgId);
  if (!memberEntry) {
    throw new Response("Not Found", { status: 404 });
  }

  if (completed) {
    if (!isCompletedOAuth(resolved.completion)) {
      return {
        ok: false,
        message: "GitHub OAuth flow has not been completed.",
        returnTo: resolved.returnTo,
      };
    }

    const returnTo = isSafeBackofficeReturnTo(resolved.completion.returnTo)
      ? resolved.completion.returnTo!
      : resolved.returnTo;

    return {
      ok: true,
      state,
      orgId: resolved.orgId,
      returnTo,
      claim: resolved.completion,
    };
  }

  const claim = await completeGitHubOAuth(request, context, resolved.orgId, {
    subjectId: me.user.id,
    state,
    code,
  });
  if (claim.error || !claim.result) {
    return {
      ok: false,
      message: claim.error ?? "Failed to verify GitHub installation access.",
      returnTo: resolved.returnTo,
    };
  }

  await githubWebhookRouterDo.storeInstallationClaimCompletion({
    state,
    userId: me.user.id,
    completion: claim.result,
  });

  const redirectUrl = new URL(requestUrl);
  redirectUrl.searchParams.delete("code");
  redirectUrl.searchParams.set("completed", "1");
  return redirect(`${redirectUrl.pathname}${redirectUrl.search}`);
}

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionData | Response> {
  const formData = await request.formData();
  const state = getStringValue(formData, "state");
  const installationId = getStringValue(formData, "installationId");
  const returnTo = getStringValue(formData, "returnTo");

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return { ok: false, message: "You must be signed in before restoring an installation." };
  }
  if (!state || !/^\d+$/.test(installationId)) {
    return { ok: false, message: "Missing claim state or installation id." };
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.resolveInstallationClaimState({
    state,
    userId: me.user.id,
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  const memberEntry = me.organizations.find((entry) => entry.organization.id === resolved.orgId);
  if (!memberEntry) {
    throw new Response("Not Found", { status: 404 });
  }

  if (!isCompletedOAuth(resolved.completion)) {
    return { ok: false, message: "GitHub OAuth flow has not been completed." };
  }
  const verifiedInstallation = resolved.completion.installations.find(
    (installation) => installation.id === installationId,
  );
  if (!verifiedInstallation) {
    return {
      ok: false,
      message: "That GitHub installation was not verified for this GitHub user.",
    };
  }

  const mappingResult = await githubWebhookRouterDo.setInstallationOrg(
    installationId,
    resolved.orgId,
  );
  if (!mappingResult.ok) {
    return {
      ok: false,
      message:
        mappingResult.code === "INSTALLATION_ORG_CONFLICT"
          ? "That GitHub installation is already linked to a different organisation."
          : mappingResult.message,
    };
  }

  const sync = await syncGitHubInstallation(request, context, resolved.orgId, installationId);
  if (sync.error || !sync.result) {
    return { ok: false, message: sync.error ?? "Failed to sync installation." };
  }

  const githubDo = getGitHubDurableObject(context, resolved.orgId);
  await githubDo.redeliverFailedInstallationWebhooks(installationId);
  await githubWebhookRouterDo.consumeInstallationClaimState({ state, userId: me.user.id });

  const safeReturnTo = isSafeBackofficeReturnTo(returnTo) ? returnTo : resolved.returnTo;
  const syncResult = sync.result;
  return redirect(
    restoreStatusRedirect(
      safeReturnTo,
      "installed_synced",
      `Restored installation ${installationId}. Synced ${syncResult.added} added, ${syncResult.updated} updated, ${syncResult.removed} removed repositories.`,
    ),
  );
}

const installationUrl = (installation: GitHubOAuthInstallation) => {
  if (installation.htmlUrl) {
    return installation.htmlUrl;
  }
  if (installation.accountType.toLowerCase() === "organization") {
    return `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${encodeURIComponent(installation.id)}`;
  }
  return `https://github.com/settings/installations/${encodeURIComponent(installation.id)}`;
};

export default function BackofficeGitHubOAuthCallback() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  if (!loaderData.ok) {
    return (
      <FormContainer
        title="Restore GitHub installation"
        eyebrow="GitHub OAuth"
        description="We could not verify access to an existing GitHub installation."
      >
        <p className="text-sm text-red-500">{loaderData.message}</p>
        {loaderData.returnTo ? (
          <Link
            to={loaderData.returnTo}
            className="mt-3 inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase"
          >
            Back to GitHub configuration
          </Link>
        ) : null}
      </FormContainer>
    );
  }

  return (
    <FormContainer
      title="Restore GitHub installation"
      eyebrow="Verified GitHub access"
      description="Choose the installation to restore for this Backoffice organisation."
    >
      <p className="text-sm text-[var(--bo-muted)]">
        Signed in to GitHub as{" "}
        <span className="font-semibold">{loaderData.claim.githubUser.login}</span>.
      </p>

      {loaderData.claim.installations.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bo-muted)]">
          No installations for this GitHub App were visible to that GitHub user.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {loaderData.claim.installations.map((installation) => (
            <section
              key={installation.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Installation {installation.id}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-[var(--bo-fg)]">
                    {installation.accountLogin}
                  </h2>
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    {installation.accountType} · {installation.repositorySelection} repositories ·{" "}
                    {installation.status}
                  </p>
                  <a
                    href={installationUrl(installation)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex text-xs text-[var(--bo-accent-fg)] underline"
                  >
                    View on GitHub
                  </a>
                </div>
                <Form method="post">
                  <input type="hidden" name="state" value={loaderData.state} />
                  <input type="hidden" name="installationId" value={installation.id} />
                  <input type="hidden" name="returnTo" value={loaderData.returnTo} />
                  <button
                    type="submit"
                    disabled={saving}
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                  >
                    Restore this installation
                  </button>
                </Form>
              </div>
            </section>
          ))}
        </div>
      )}

      {actionData && !actionData.ok ? (
        <p className="mt-3 text-xs text-red-500">{actionData.message}</p>
      ) : null}
    </FormContainer>
  );
}
