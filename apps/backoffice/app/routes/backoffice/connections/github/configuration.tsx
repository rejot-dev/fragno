import { useEffect } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
} from "react-router";

import { FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  getGitHubDurableObject,
  getGitHubWebhookRouterDurableObject,
} from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import {
  resolveAuthenticatedIntegrationContext,
  resolveOrganizationScopeFromRouteParams,
} from "../../integrations/scope";
import type { Route } from "./+types/configuration";
import {
  fetchGitHubAdminConfig,
  fetchGitHubInstallationRepos,
  fetchGitHubInstallations,
  linkGitHubRepository,
  startGitHubOAuth,
  syncGitHubInstallation,
  unlinkGitHubRepository,
  type GitHubInstallationSummary,
  type GitHubRepositorySummary,
} from "./data";
import { formatTimestamp, type GitHubLayoutContext } from "./shared";

const INSTALL_FLOW_QUERY = "installFlow";

const INSTALL_FLOW_MESSAGES = {
  installed: {
    tone: "success",
    message: "GitHub installation callback validated and linked to this organisation.",
  },
  installed_pending_webhook: {
    tone: "warning",
    message:
      "GitHub callback validated, but the installation is not in local state yet. Wait for webhook delivery and refresh this page.",
  },
  installed_synced: {
    tone: "success",
    message: "GitHub installation callback validated, linked to this organisation, and synced.",
  },
  install_requested: {
    tone: "warning",
    message:
      "GitHub install request was submitted for approval. Complete approval in GitHub before linking repositories.",
  },
  missing_callback_data: {
    tone: "error",
    message:
      "GitHub callback is missing required parameters. Start installation from this page again.",
  },
  invalid_installation: {
    tone: "error",
    message: "GitHub callback returned an invalid installation id.",
  },
  invalid_state: {
    tone: "error",
    message: "Install state is invalid or already used. Start installation from this page again.",
  },
  expired_state: {
    tone: "error",
    message: "Install state expired. Start installation from this page again.",
  },
  user_mismatch: {
    tone: "error",
    message:
      "Install state belongs to a different signed-in user. Sign in with the original user and retry.",
  },
  callback_error: {
    tone: "error",
    message: "Failed to validate the GitHub install callback. Start installation again.",
  },
} as const;

type InstallFlowCode = keyof typeof INSTALL_FLOW_MESSAGES;

type InstallFlowNotice = {
  tone: "success" | "warning" | "error";
  message: string;
} | null;

type InstallationWithRepos = {
  installation: GitHubInstallationSummary;
  repos: GitHubRepositorySummary[];
  reposError: string | null;
  linkedCount: number;
};

type GitHubConfigurationActionData = {
  ok: boolean;
  message: string;
};

const getStringValue = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const isValidInstallationId = (value: string) => /^\d+$/.test(value);

const toStatePreview = (value: string) => (value ? `${value.slice(0, 8)}…` : "");

const actionErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const buildGitHubInstallationUrl = (installation: GitHubInstallationSummary | null | undefined) => {
  if (!installation) {
    return null;
  }

  const installationId = installation.id.trim();
  if (!installationId) {
    return null;
  }

  const encodedInstallationId = encodeURIComponent(installationId);
  const accountType = installation.accountType.trim().toLowerCase();
  const accountLogin = installation.accountLogin.trim();

  if (accountType === "organization" && accountLogin.length > 0) {
    return `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${encodedInstallationId}`;
  }

  return `https://github.com/settings/installations/${encodedInstallationId}`;
};

const buildConfigurationRedirect = (requestUrl: URL, code: InstallFlowCode, detail?: string) => {
  const url = new URL(requestUrl);
  url.searchParams.delete("state");
  url.searchParams.delete("installation_id");
  url.searchParams.delete("setup_action");
  url.searchParams.set(INSTALL_FLOW_QUERY, code);
  url.searchParams.delete(`${INSTALL_FLOW_QUERY}Detail`);
  if (detail && detail.trim().length > 0) {
    url.searchParams.set(`${INSTALL_FLOW_QUERY}Detail`, detail.trim().slice(0, 240));
  }
  return `${url.pathname}${url.search}`;
};

const readInstallNotice = (requestUrl: URL): InstallFlowNotice => {
  const code = requestUrl.searchParams.get(INSTALL_FLOW_QUERY);
  if (!code) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(INSTALL_FLOW_MESSAGES, code)) {
    return null;
  }
  const notice = INSTALL_FLOW_MESSAGES[code as InstallFlowCode];
  const detail = requestUrl.searchParams.get(`${INSTALL_FLOW_QUERY}Detail`)?.trim();
  return detail ? { ...notice, message: `${notice.message} ${detail}` } : notice;
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const organizationScope = resolveOrganizationScopeFromRouteParams(params);
  const organizationId = organizationScope.organizationId;

  const requestUrl = url;
  const origin = requestUrl.origin;
  const callbackState = requestUrl.searchParams.get("state")?.trim() ?? "";
  const callbackInstallationId = requestUrl.searchParams.get("installation_id")?.trim() ?? "";
  const setupAction = requestUrl.searchParams.get("setup_action")?.trim() ?? "";

  if (setupAction === "request") {
    return redirect(buildConfigurationRedirect(requestUrl, "install_requested"));
  }

  if (callbackState || callbackInstallationId || setupAction) {
    if (!callbackState || !callbackInstallationId) {
      console.warn("GitHub install callback missing required parameters", {
        organizationId: organizationId,
        setupAction,
        hasState: Boolean(callbackState),
        hasInstallationId: Boolean(callbackInstallationId),
      });
      return redirect(buildConfigurationRedirect(requestUrl, "missing_callback_data"));
    }

    if (!isValidInstallationId(callbackInstallationId)) {
      console.warn("GitHub install callback provided invalid installation id", {
        organizationId: organizationId,
        installationId: callbackInstallationId,
        state: toStatePreview(callbackState),
      });
      return redirect(buildConfigurationRedirect(requestUrl, "invalid_installation"));
    }

    const me = await getAuthMe(request, context);
    if (!me?.user) {
      return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
    }
    const memberEntry = me.organizations.find((entry) => entry.organization.id === organizationId);
    if (!memberEntry) {
      throw new Response("Not Found", { status: 404 });
    }

    try {
      const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
      const consumed = await githubWebhookRouterDo.consumeInstallState({
        state: callbackState,
        userId: me.user.id,
        installationId: callbackInstallationId,
      });

      if (!consumed.ok) {
        console.warn("GitHub install callback state validation failed", {
          organizationId: organizationId,
          code: consumed.code,
          message: consumed.message,
          installationId: callbackInstallationId,
          state: toStatePreview(callbackState),
          userId: me.user.id,
        });
        if (consumed.code === "EXPIRED_STATE") {
          return redirect(buildConfigurationRedirect(requestUrl, "expired_state"));
        }
        if (consumed.code === "USER_MISMATCH") {
          return redirect(buildConfigurationRedirect(requestUrl, "user_mismatch"));
        }
        return redirect(buildConfigurationRedirect(requestUrl, "invalid_state"));
      }

      if (consumed.orgId !== organizationId) {
        console.warn("GitHub install callback resolved to a different organisation", {
          requestedOrgId: organizationId,
          resolvedOrgId: consumed.orgId,
          installationId: callbackInstallationId,
          state: toStatePreview(callbackState),
          userId: me.user.id,
        });
        return redirect(buildConfigurationRedirect(requestUrl, "callback_error"));
      }

      const mappingResult = await githubWebhookRouterDo.setInstallationOrg(
        callbackInstallationId,
        organizationId,
      );
      if (!mappingResult.ok) {
        console.error("GitHub install callback failed to map installation to organisation", {
          organizationId: organizationId,
          installationId: callbackInstallationId,
          state: toStatePreview(callbackState),
          userId: me.user.id,
          code: mappingResult.code,
          existingOrgId: mappingResult.existingOrgId,
          error: mappingResult.message,
        });
        return redirect(buildConfigurationRedirect(requestUrl, "callback_error"));
      }

      const syncResult = await syncGitHubInstallation(
        request,
        context,
        organizationId,
        callbackInstallationId,
      );
      if (syncResult.error || !syncResult.result) {
        console.warn("GitHub install callback mapped installation but sync failed", {
          organizationId: organizationId,
          installationId: callbackInstallationId,
          error: syncResult.error,
        });

        const githubDo = getGitHubDurableObject(context, organizationId);
        await githubDo.redeliverFailedInstallationWebhooks(callbackInstallationId);

        return redirect(buildConfigurationRedirect(requestUrl, "installed_pending_webhook"));
      }

      return redirect(buildConfigurationRedirect(requestUrl, "installed_synced"));
    } catch (error) {
      console.error("GitHub install callback processing threw", {
        organizationId: organizationId,
        installationId: callbackInstallationId,
        state: toStatePreview(callbackState),
        error,
      });
      return redirect(buildConfigurationRedirect(requestUrl, "callback_error"));
    }
  }

  const installNotice = readInstallNotice(requestUrl);
  const { configState, configError } = await fetchGitHubAdminConfig(
    context,
    organizationId,
    origin,
  );
  if (configError) {
    return {
      configState,
      configError,
      installations: [],
      installationsError: null,
      installNotice,
    };
  }

  if (!configState?.configured) {
    return {
      configState,
      configError: null,
      installations: [],
      installationsError: null,
      installNotice,
    };
  }

  const { installations, installationsError } = await fetchGitHubInstallations(
    request,
    context,
    organizationId,
    "active",
  );
  if (installationsError) {
    return {
      configState,
      configError: null,
      installations: [],
      installationsError,
      installNotice,
    };
  }

  const installationsWithRepos = await Promise.all(
    installations.map(async (installation) => {
      const reposResult = await fetchGitHubInstallationRepos(
        request,
        context,
        organizationId,
        installation.id,
      );

      const linkedCount = reposResult.repos.reduce(
        (count, repo) => count + (repo.linkKeys.length > 0 ? 1 : 0),
        0,
      );

      return {
        installation,
        repos: reposResult.repos,
        reposError: reposResult.reposError,
        linkedCount,
      } satisfies InstallationWithRepos;
    }),
  );

  return {
    configState,
    configError: null,
    installations: installationsWithRepos,
    installationsError: null,
    installNotice,
  };
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const integration = await resolveAuthenticatedIntegrationContext({
    request,
    context,
    params,
    integration: "github",
    allowedScopes: ["org"],
  });
  if (integration.scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }
  const organizationId = integration.scope.orgId;
  const { me } = integration;

  const formData = await request.formData();
  const intent = getStringValue(formData, "intent");

  if (intent === "start-installation") {
    const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
    const install = await githubWebhookRouterDo.createInstallStatefulUrl(
      me.user.id,
      organizationId,
    );
    if (!install.ok) {
      console.error("Failed to create GitHub install stateful URL", {
        organizationId: organizationId,
        userId: me.user.id,
        message: install.message,
        missing: install.missing,
        error: install.error,
      });
      const missing = install.missing?.length ? ` Missing: ${install.missing.join(", ")}.` : "";
      const details = install.error ? ` ${install.error}` : "";
      return {
        ok: false,
        message: `${install.message}${missing}${details}`,
      } satisfies GitHubConfigurationActionData;
    }

    return redirect(install.installUrl);
  }

  if (intent === "connect-existing-installation") {
    const returnTo = `${url.pathname}${url.search}`;
    const claim = await startGitHubOAuth(request, context, organizationId, {
      subjectId: me.user.id,
      returnTo,
    });
    if (claim.error || !claim.result) {
      return {
        ok: false,
        message: claim.error ?? "Failed to start installation restore.",
      } satisfies GitHubConfigurationActionData;
    }

    const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
    try {
      await githubWebhookRouterDo.storeInstallationClaimState({
        state: claim.result.state,
        userId: me.user.id,
        orgId: integration.scope.orgId,
        returnTo,
        expiresAt: new Date(claim.result.expiresAt).getTime(),
      });
    } catch (error) {
      console.warn("Failed to store GitHub installation claim state", {
        organizationId: organizationId,
        userId: me.user.id,
        state: toStatePreview(claim.result.state),
        error,
      });
      return {
        ok: false,
        message: actionErrorMessage(error, "Failed to prepare GitHub installation restore."),
      } satisfies GitHubConfigurationActionData;
    }

    return redirect(claim.result.authorizationUrl);
  }

  if (intent === "link-repo") {
    const installationId = getStringValue(formData, "installationId");
    const repoId = getStringValue(formData, "repoId");
    if (!installationId || !repoId) {
      return {
        ok: false,
        message: "Missing installation or repository id.",
      } satisfies GitHubConfigurationActionData;
    }

    const result = await linkGitHubRepository(request, context, organizationId, {
      installationId,
      repoId,
    });
    if (result.error || !result.result) {
      console.warn("Failed to link GitHub repository", {
        organizationId: organizationId,
        installationId,
        repoId,
        error: result.error ?? "Failed to link repository.",
      });
      return {
        ok: false,
        message: result.error ?? "Failed to link repository.",
      } satisfies GitHubConfigurationActionData;
    }

    return {
      ok: true,
      message: `Linked ${result.result.repo.fullName}.`,
    } satisfies GitHubConfigurationActionData;
  }

  if (intent === "unlink-repo") {
    const repoId = getStringValue(formData, "repoId");
    if (!repoId) {
      return {
        ok: false,
        message: "Missing repository id.",
      } satisfies GitHubConfigurationActionData;
    }

    const result = await unlinkGitHubRepository(request, context, organizationId, {
      repoId,
    });
    if (result.error || !result.ok) {
      console.warn("Failed to unlink GitHub repository", {
        organizationId: organizationId,
        repoId,
        error: result.error ?? "Failed to unlink repository.",
      });
      return {
        ok: false,
        message: result.error ?? "Failed to unlink repository.",
      } satisfies GitHubConfigurationActionData;
    }

    return {
      ok: true,
      message: "Repository unlinked.",
    } satisfies GitHubConfigurationActionData;
  }

  return {
    ok: false,
    message: "Unsupported action.",
  } satisfies GitHubConfigurationActionData;
}

export default function BackofficeOrganisationGitHubConfiguration() {
  const { configState, configError, setConfigState, setConfigError } =
    useOutletContext<GitHubLayoutContext>();
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  useEffect(() => {
    setConfigState(loaderData.configState);
    setConfigError(loaderData.configError);
  }, [loaderData.configError, loaderData.configState, setConfigError, setConfigState]);

  const saveError = actionData && !actionData.ok ? actionData.message : null;
  const saveSuccess = actionData && actionData.ok ? actionData.message : null;
  const installNotice = loaderData.installNotice;
  const linkingAvailable = Boolean(configState?.configured);
  const hasActiveInstallation = loaderData.installations.length > 0;
  const primaryInstallation = loaderData.installations[0]?.installation;
  const githubInstallationUrl = buildGitHubInstallationUrl(primaryInstallation);
  const installNoticeToneClass =
    installNotice?.tone === "success"
      ? "border-green-200 bg-green-50 text-green-700"
      : installNotice?.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-red-200 bg-red-50 text-red-700";

  return (
    <div className="space-y-4">
      {installNotice ? (
        <p className={`border px-3 py-2 text-xs ${installNoticeToneClass}`}>
          {installNotice.message}
        </p>
      ) : null}
      {configError ? (
        <p className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {configError}
        </p>
      ) : null}

      {!linkingAvailable ? (
        <FormContainer
          title="GitHub linking not available"
          eyebrow="Unavailable"
          description="GitHub linking is currently unavailable for this workspace."
        >
          <p className="text-sm text-[var(--bo-muted)]">
            The GitHub integration is not configured correctly yet. An operator needs to finish the
            GitHub setup before repositories can be linked.
          </p>
          <div className="mt-3">
            <Link
              to="/backoffice/internals/github"
              className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              View operator details
            </Link>
          </div>
        </FormContainer>
      ) : (
        <>
          <FormContainer
            title={hasActiveInstallation ? "GitHub App connected" : "Connect the GitHub App"}
            eyebrow="Installation"
            description={
              hasActiveInstallation
                ? "Manage the GitHub App installation linked to this organisation."
                : "Install the app for the first time, or reconnect an installation that already exists in GitHub."
            }
          >
            {hasActiveInstallation && githubInstallationUrl ? (
              <>
                <p className="text-sm text-[var(--bo-muted)]">
                  Installation is configured for this organisation. Open GitHub to manage
                  installation settings or review app authorizations for your GitHub account.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={githubInstallationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    View installation on GitHub
                  </a>
                  <a
                    href="https://github.com/settings/apps/authorizations"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  >
                    View GitHub authorizations
                  </a>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <section className="flex flex-col justify-between border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                    <div>
                      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase">
                        New install
                      </p>
                      <h2 className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                        Install the app into GitHub
                      </h2>
                      <p className="mt-2 text-sm text-[var(--bo-muted)]">
                        Choose repositories in GitHub and return here automatically. This is the
                        fastest path when the app is not installed yet.
                      </p>
                    </div>
                    <Form method="post" className="mt-4">
                      <input type="hidden" name="intent" value="start-installation" />
                      <button
                        type="submit"
                        disabled={saving}
                        className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                      >
                        Start GitHub install
                      </button>
                    </Form>
                  </section>

                  <section className="flex flex-col justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                    <div>
                      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Existing install
                      </p>
                      <h2 className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                        Connect an existing installation
                      </h2>
                      <p className="mt-2 text-sm text-[var(--bo-muted)]">
                        Already installed? Sign in with GitHub and pick from installations your
                        GitHub user can access. No pasted installation ids.
                      </p>
                    </div>
                    <Form method="post" className="mt-4">
                      <input type="hidden" name="intent" value="connect-existing-installation" />
                      <button
                        type="submit"
                        disabled={saving}
                        className="inline-flex min-h-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                      >
                        Find existing install
                      </button>
                    </Form>
                  </section>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2">
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    Not sure whether it is already installed? Check GitHub first, switch to the
                    right GitHub organisation if needed, then return here.
                  </p>
                  <a
                    href="https://github.com/settings/apps/authorizations"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase underline underline-offset-4 transition-colors hover:text-[var(--bo-fg)]"
                  >
                    View existing installations
                  </a>
                </div>
              </>
            )}
          </FormContainer>

          <FormContainer
            title="Installations and repository links"
            eyebrow="Connection state"
            description="Installations become available after callback and webhook processing. Link repositories here."
          >
            {loaderData.installationsError ? (
              <p className="text-sm text-red-500">{loaderData.installationsError}</p>
            ) : loaderData.installations.length === 0 ? (
              <p className="text-sm text-[var(--bo-muted)]">
                No active installations yet. Start installation above. If you just installed,
                webhook processing may still be catching up.
              </p>
            ) : (
              <div className="space-y-3">
                {loaderData.installations.map(
                  ({ installation, repos, reposError, linkedCount }) => (
                    <section
                      key={installation.id}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                            Installation {installation.id}
                          </p>
                          <h3 className="mt-1 text-lg font-semibold text-[var(--bo-fg)]">
                            {installation.accountLogin}
                          </h3>
                          <p className="text-xs text-[var(--bo-muted-2)]">
                            Status: {installation.status} · Last webhook{" "}
                            {formatTimestamp(installation.lastWebhookAt) || "never"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                            {linkedCount}/{repos.length} linked
                          </span>
                        </div>
                      </div>

                      {reposError ? (
                        <p className="mt-3 text-sm text-red-500">{reposError}</p>
                      ) : repos.length === 0 ? (
                        <p className="mt-3 text-sm text-[var(--bo-muted)]">
                          No repositories returned for this installation.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {repos.map((repo) => {
                            const linked = repo.linkKeys.length > 0;
                            return (
                              <div
                                key={repo.id}
                                className="flex flex-wrap items-center justify-between gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2"
                              >
                                <div>
                                  <p className="text-sm font-semibold text-[var(--bo-fg)]">
                                    {repo.fullName}
                                  </p>
                                  <p className="text-xs text-[var(--bo-muted-2)]">
                                    {repo.defaultBranch
                                      ? `default: ${repo.defaultBranch}`
                                      : "no default branch"}{" "}
                                    · {repo.isPrivate ? "private" : "public"} ·{" "}
                                    {repo.isFork ? "fork" : "source"}
                                  </p>
                                </div>
                                <Form method="post">
                                  {linked ? (
                                    <>
                                      <input type="hidden" name="intent" value="unlink-repo" />
                                      <input type="hidden" name="repoId" value={repo.id} />
                                      <button
                                        type="submit"
                                        disabled={saving}
                                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                                      >
                                        Unlink
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <input type="hidden" name="intent" value="link-repo" />
                                      <input
                                        type="hidden"
                                        name="installationId"
                                        value={installation.id}
                                      />
                                      <input type="hidden" name="repoId" value={repo.id} />
                                      <button
                                        type="submit"
                                        disabled={saving}
                                        className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                                      >
                                        Link repo
                                      </button>
                                    </>
                                  )}
                                </Form>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  ),
                )}
              </div>
            )}

            {saveError ? <p className="mt-3 text-xs text-red-500">{saveError}</p> : null}
            {saveSuccess ? <p className="mt-3 text-xs text-green-500">{saveSuccess}</p> : null}
          </FormContainer>
        </>
      )}
    </div>
  );
}
