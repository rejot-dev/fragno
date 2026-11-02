import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { FormContainer } from "@fragno-private/design-system/forms/form-container";
import { useEffect } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type RouterContextProvider,
} from "react-router";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { GitHubInstallationOwner } from "@/fragno/github";
import {
  bindGitHubInstallation,
  finishGitHubSignIn,
  gitHubInstallationUrl,
  describeGitHubInstallation,
  signInRepositories,
  type GitHubSignInOutcome,
  type GitHubSignInPurpose,
} from "@/fragno/github-access";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import {
  getGitHubDurableObject,
  getGitHubWebhookRouterDurableObject,
} from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { integrationOAuthReturn } from "../../integrations/connection-paths";
import type { Route } from "./+types/oauth-callback";
import { createGitHubRouteCaller, type GitHubOAuthComplete } from "./data";
import { gitHubWorkspace } from "./workspace.server";

const getStringValue = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

// Without resolved claim state the page that started the flow is unknown.
const UNKNOWN_RETURN_TO = "/backoffice/integrations";

const restoreStatusRedirect = (returnTo: string, code: string, detail?: string) => {
  const url = new URL(returnTo, "https://backoffice.local");
  url.searchParams.set("installFlow", code);
  if (detail) {
    url.searchParams.set("installFlowDetail", detail.slice(0, 240));
  }
  return `${url.pathname}${url.search}`;
};

/** Another workspace an installation serves, named only to its members. */
type OtherWorkspace = { label: string; configurationPath: string } | null;

/** What a finished sign-in did that the user has to read, or act on, on this page. */
type SignInOutcomeView =
  | Extract<GitHubSignInOutcome, { kind: "bound" }>
  | {
      kind: "conflict";
      installation: { id: string; account: string; url: string };
      workspace: OtherWorkspace;
    }
  | { kind: "not-verified"; installationId: string }
  | { kind: "moving"; installation: { id: string; account: string; url: string } };

type LoaderData =
  | { ok: true; kind: "choose"; state: string; returnTo: string; claim: GitHubOAuthComplete }
  | {
      ok: true;
      kind: "outcome";
      state: string;
      returnTo: string;
      githubLogin: string | null;
      /** This workspace's name, which a move names. */
      workspaceLabel: string;
      outcome: SignInOutcomeView;
    }
  | { ok: false; message: string; returnTo: string };

type ActionData = { ok: false; message: string };

/** A claim restores into a workspace the user may still act in; others are not found. */
async function requireClaimWorkspace(
  request: Request,
  context: Route.LoaderArgs["context"],
  owner: GitHubInstallationOwner,
) {
  try {
    await requireBackofficeContext(request, context, owner);
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }
}

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

/** Only this route stores outcomes, from `finishGitHubSignIn`. */
const isSignInOutcome = (value: unknown): value is GitHubSignInOutcome =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { kind?: unknown }).kind === "string";

/** System's Automations, which move installations between workspaces. */
function systemAutomations(context: Readonly<RouterContextProvider>) {
  return context.get(BackofficeWorkerContext).runtime.objects.automations.singleton().commands;
}

/** Shows a sign-in's stored outcome on this page. */
function showCompleted(requestUrl: URL, state: string) {
  const url = new URL(requestUrl);
  url.search = "";
  url.searchParams.set("state", state);
  url.searchParams.set("completed", "1");
  return redirect(`${url.pathname}${url.search}`);
}

/** Where a sign-in that linked everything it was asked to returns. */
function signedInRedirect(
  request: Request,
  me: BackofficeMeData,
  owner: GitHubInstallationOwner,
  purpose: GitHubSignInPurpose,
  returnTo: string,
) {
  if (purpose.kind === "install") {
    return redirect(restoreStatusRedirect(returnTo, "installed_synced"));
  }
  const workspace = gitHubWorkspace(me, owner);
  return workspace
    ? integrationOAuthReturn({
        request,
        routeScope: workspace.routeScope,
        connectionId: null,
        outcome: { status: "success" },
      })
    : redirect(returnTo);
}

const linkedEverything = (outcome: GitHubSignInOutcome) =>
  outcome.kind === "bound" && outcome.synced && outcome.missing.length === 0;

/** The workspace's integrations, where sign-ins started by integration setup return. */
function integrationsPath(me: BackofficeMeData, owner: GitHubInstallationOwner) {
  const workspace = gitHubWorkspace(me, owner);
  return workspace
    ? `/backoffice/integrations/${backofficeRouteScopePath(workspace.routeScope)}`
    : UNKNOWN_RETURN_TO;
}

/** Names the workspace an installation serves to its members; a personal one only to its user. */
function otherWorkspace(
  me: BackofficeMeData,
  owner: GitHubInstallationOwner | null,
): OtherWorkspace {
  if (owner === null || (owner.kind === "user" && owner.userId !== me.user.id)) {
    return null;
  }
  const workspace = gitHubWorkspace(me, owner);
  return (
    workspace && {
      label: workspace.label,
      configurationPath: `/backoffice/integrations/${backofficeRouteScopePath(workspace.routeScope)}/github/configuration`,
    }
  );
}

function outcomeView(
  me: BackofficeMeData,
  outcome: GitHubSignInOutcome,
): SignInOutcomeView | { kind: "failed"; message: string } {
  switch (outcome.kind) {
    case "bound":
    case "not-verified":
    case "failed":
      return outcome;
    case "moving":
      return { kind: "moving", installation: outcome.installation };
    case "conflict":
      return {
        kind: "conflict",
        installation: outcome.installation,
        workspace: otherWorkspace(me, outcome.owner),
      };
    case "install":
      // Followed at once; a stored one only shows up when the page is opened again.
      return { kind: "failed", message: "Continue the GitHub App install that GitHub opened." };
    default:
      throw new Error("Unknown GitHub sign-in outcome.", { cause: outcome satisfies never });
  }
}

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

  const { me } = getBackofficeShellRequest(context);

  if (githubError) {
    return {
      ok: false,
      message: githubErrorDescription || `GitHub authorization failed: ${githubError}`,
      returnTo: UNKNOWN_RETURN_TO,
    };
  }
  if (!state || (!code && !completed)) {
    return {
      ok: false,
      message: "GitHub OAuth callback is missing state or code.",
      returnTo: UNKNOWN_RETURN_TO,
    };
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.commands.resolveInstallationClaimState({
    state,
    userId: me.user.id,
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message, returnTo: UNKNOWN_RETURN_TO };
  }

  const { owner, purpose } = resolved;
  await requireClaimWorkspace(request, context, owner);
  const returnTo = resolved.returnTo || integrationsPath(me, owner);

  if (completed) {
    const githubLogin = isCompletedOAuth(resolved.completion)
      ? resolved.completion.githubUser.login
      : null;
    if (purpose.kind === "choose") {
      if (!isCompletedOAuth(resolved.completion)) {
        return { ok: false, message: "GitHub OAuth flow has not been completed.", returnTo };
      }
      return { ok: true, kind: "choose", state, returnTo, claim: resolved.completion };
    }
    if (!isSignInOutcome(resolved.outcome)) {
      return { ok: false, message: "GitHub sign-in has not been completed.", returnTo };
    }
    let outcome: GitHubSignInOutcome = resolved.outcome;
    if (outcome.kind === "moving") {
      const move = await systemAutomations(context).readGitHubInstallationMove({
        instanceId: outcome.instanceId,
      });
      if (move.status === "failed") {
        return {
          ok: false,
          message: `Moving the installation on ${outcome.installation.account} failed: ${move.message}`,
          returnTo,
        };
      }
      if (move.status === "moved") {
        if (linkedEverything(move.outcome)) {
          return signedInRedirect(request, me, owner, purpose, returnTo);
        }
        outcome = move.outcome;
      }
    }
    const view = outcomeView(me, outcome);
    return view.kind === "failed"
      ? { ok: false, message: view.message, returnTo }
      : {
          ok: true,
          kind: "outcome",
          state,
          returnTo,
          githubLogin,
          workspaceLabel: gitHubWorkspace(me, owner)?.label ?? "this workspace",
          outcome: view,
        };
  }

  const result = await finishGitHubSignIn({
    router: githubWebhookRouterDo.commands,
    github: getGitHubDurableObject(context, owner).commands,
    callRoute: createGitHubRouteCaller(request, context, owner),
    userId: me.user.id,
    owner,
    purpose,
    state,
    code,
  });
  switch (result.kind) {
    case "failed":
      return { ok: false, message: result.message, returnTo };
    case "install":
      return redirect(result.installUrl);
    case "bound":
      return linkedEverything(result)
        ? signedInRedirect(request, me, owner, purpose, returnTo)
        : showCompleted(requestUrl, state);
    case "choose":
    case "conflict":
    case "not-verified":
    case "moving":
      return showCompleted(requestUrl, state);
    default:
      throw new Error("Unknown GitHub sign-in result.", { cause: result satisfies never });
  }
}

/**
 * Moves the installation a sign-in found serving another workspace to this one. The sign-in showed
 * the user reaches it on GitHub; moving also needs managing GitHub in both workspaces.
 */
async function moveInstallation(
  request: Request,
  context: Route.ActionArgs["context"],
  me: BackofficeMeData,
  state: string,
): Promise<ActionData | Response> {
  const router = getGitHubWebhookRouterDurableObject(context).commands;
  const resolved = await router.resolveInstallationClaimState({ state, userId: me.user.id });
  if (!resolved.ok) {
    return { ok: false, message: `${resolved.message} Ask your agent for a new GitHub link.` };
  }
  const { owner, purpose, outcome, completion } = resolved;
  await requireClaimWorkspace(request, context, owner);
  const conflict =
    isSignInOutcome(outcome) && outcome.kind === "conflict" && outcome.owner !== null
      ? { ...outcome, owner: outcome.owner }
      : null;
  const installation =
    conflict && isCompletedOAuth(completion)
      ? completion.installations.find(({ id }) => id === conflict.installation.id)
      : undefined;
  if (!conflict || !installation) {
    return {
      ok: false,
      message: "There is no installation to move. Ask your agent for a new GitHub link.",
    };
  }
  const from = conflict.owner;
  const fromLabel = otherWorkspace(me, from)?.label ?? "the workspace it serves";
  const { kernel } = context.get(BackofficeWorkerContext);
  const manage = <T,>(
    execution: Awaited<ReturnType<typeof requireBackofficeContext>>,
    execute: () => Promise<T>,
  ) =>
    kernel.invoke({
      execution,
      operation: BACKOFFICE_PERMISSION.connections.manage,
      resource: { capabilityId: "github", installationId: installation.id },
      execute,
    });
  let instanceId: string;
  try {
    const [fromExecution, execution] = await Promise.all([
      requireBackofficeContext(request, context, from),
      requireBackofficeContext(request, context, owner),
    ]);
    ({ instanceId } = await manage(fromExecution, () =>
      manage(execution, () =>
        systemAutomations(context).startGitHubInstallationMove({
          signInState: state,
          move: { installation, from, to: owner, repositories: signInRepositories(purpose) },
        }),
      ),
    ));
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      return {
        ok: false,
        message: `Moving the installation needs permission to manage GitHub in ${fromLabel} and here.`,
      };
    }
    throw error;
  }
  await router.storeInstallationClaimCompletion({
    state,
    userId: me.user.id,
    completion,
    outcome: {
      kind: "moving",
      installation: describeGitHubInstallation(installation),
      instanceId,
    } satisfies GitHubSignInOutcome,
  });
  return showCompleted(new URL(request.url), state);
}

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionData | Response> {
  const formData = await request.formData();
  const state = getStringValue(formData, "state");
  const installationId = getStringValue(formData, "installationId");

  const { me } = getBackofficeShellRequest(context);
  if (state && getStringValue(formData, "intent") === "move") {
    return await moveInstallation(request, context, me, state);
  }
  if (!state || !/^\d+$/.test(installationId)) {
    return { ok: false, message: "Missing claim state or installation id." };
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const resolved = await githubWebhookRouterDo.commands.resolveInstallationClaimState({
    state,
    userId: me.user.id,
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  const owner = resolved.owner;
  await requireClaimWorkspace(request, context, owner);

  if (resolved.purpose.kind !== "choose" || !isCompletedOAuth(resolved.completion)) {
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

  const outcome = await bindGitHubInstallation({
    router: githubWebhookRouterDo.commands,
    github: getGitHubDurableObject(context, owner).commands,
    callRoute: createGitHubRouteCaller(request, context, owner),
    owner,
    installation: verifiedInstallation,
    repositories: [],
  });
  if (outcome.kind === "conflict") {
    const workspace = otherWorkspace(me, outcome.owner);
    return {
      ok: false,
      message: workspace
        ? `That GitHub installation is linked to ${workspace.label}. An installation serves one workspace at a time.`
        : "That GitHub installation is already linked to another Leyway workspace.",
    };
  }
  if (outcome.kind !== "bound") {
    return {
      ok: false,
      message: outcome.kind === "failed" ? outcome.message : "Failed to restore installation.",
    };
  }
  await githubWebhookRouterDo.commands.consumeInstallationClaimState({ state, userId: me.user.id });
  return redirect(
    restoreStatusRedirect(
      resolved.returnTo || integrationsPath(me, owner),
      outcome.synced ? "installed_synced" : "installed_pending_webhook",
      outcome.synced ? `Restored installation ${installationId}.` : undefined,
    ),
  );
}

export default function BackofficeGitHubOAuthCallback() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  if (!loaderData.ok) {
    return (
      <FormContainer
        title="GitHub access"
        eyebrow="GitHub sign-in"
        description="We could not verify your access on GitHub."
      >
        <p className="text-sm text-red-500">{loaderData.message}</p>
        <ButtonLink variant="secondary" to={loaderData.returnTo} className="mt-3">
          Back
        </ButtonLink>
      </FormContainer>
    );
  }

  if (loaderData.kind === "outcome") {
    return (
      <SignInOutcome
        state={loaderData.state}
        outcome={loaderData.outcome}
        githubLogin={loaderData.githubLogin}
        workspaceLabel={loaderData.workspaceLabel}
        returnTo={loaderData.returnTo}
        actionMessage={actionData && !actionData.ok ? actionData.message : null}
        saving={saving}
      />
    );
  }

  return (
    <FormContainer
      title="Restore GitHub installation"
      eyebrow="Verified GitHub access"
      description="Choose the installation to restore for this Leyway workspace."
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
                    href={gitHubInstallationUrl(installation)}
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
                  <Button variant="accent" type="submit" disabled={saving}>
                    Restore this installation
                  </Button>
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

const externalLinkClassName =
  "inline-flex text-sm font-semibold text-[var(--bo-accent-fg)] underline underline-offset-4";

/** What a sign-in did, when it did not simply link everything it was asked to. */
/** The move runs in the background; the page reloads until it ends. */
function MovingInstallation({
  account,
  workspaceLabel,
}: {
  account: string;
  workspaceLabel: string;
}) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    // A reload already under way schedules the next one when it settles.
    if (state !== "idle") {
      return undefined;
    }
    const timer = setTimeout(() => {
      void revalidate();
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [revalidate, state]);
  return (
    <FormContainer
      title="Moving the installation"
      eyebrow="GitHub access"
      description={`The GitHub App on ${account} is moving to ${workspaceLabel}.`}
    >
      <p className="mt-3 text-sm text-[var(--bo-fg)]">
        Disconnecting its repositories from the other workspace, then linking them here. This page
        updates when it is done; you can also leave, and the move finishes on its own.
      </p>
    </FormContainer>
  );
}

function SignInOutcome({
  state,
  outcome,
  githubLogin,
  workspaceLabel,
  returnTo,
  actionMessage,
  saving,
}: {
  state: string;
  outcome: SignInOutcomeView;
  githubLogin: string | null;
  workspaceLabel: string;
  returnTo: string;
  actionMessage: string | null;
  saving: boolean;
}) {
  switch (outcome.kind) {
    case "moving":
      return (
        <MovingInstallation
          account={outcome.installation.account}
          workspaceLabel={workspaceLabel}
        />
      );
    case "not-verified":
      return (
        <NotVerifiedOutcome
          installationId={outcome.installationId}
          githubLogin={githubLogin}
          returnTo={returnTo}
        />
      );
    case "conflict":
      return (
        <ConflictOutcome
          outcome={outcome}
          state={state}
          githubLogin={githubLogin}
          workspaceLabel={workspaceLabel}
          returnTo={returnTo}
          actionMessage={actionMessage}
          saving={saving}
        />
      );
    case "bound":
      return <BoundOutcome outcome={outcome} githubLogin={githubLogin} returnTo={returnTo} />;
    default:
      throw new Error("Unknown GitHub sign-in outcome.", { cause: outcome satisfies never });
  }
}

function SignedInAs({ githubLogin }: { githubLogin: string | null }) {
  return githubLogin ? (
    <p className="text-sm text-[var(--bo-muted)]">
      Signed in to GitHub as <span className="font-semibold">{githubLogin}</span>.
    </p>
  ) : null;
}

function BackToLeyway({ returnTo }: { returnTo: string }) {
  return (
    <ButtonLink variant="secondary" to={returnTo} className="mt-4">
      Back to Leyway
    </ButtonLink>
  );
}

function NotVerifiedOutcome({
  installationId,
  githubLogin,
  returnTo,
}: {
  installationId: string;
  githubLogin: string | null;
  returnTo: string;
}) {
  return (
    <FormContainer
      title="Installation not linked"
      eyebrow="GitHub access"
      description="Your GitHub account cannot reach the installation GitHub returned with."
    >
      <SignedInAs githubLogin={githubLogin} />
      <p className="mt-3 text-sm text-[var(--bo-fg)]">
        Installation {installationId} is not one your GitHub account can access, so it was not
        linked to this workspace. Sign in to GitHub with an account that manages the installation
        and start again.
      </p>
      <BackToLeyway returnTo={returnTo} />
    </FormContainer>
  );
}

function ConflictOutcome({
  outcome: { installation, workspace },
  state,
  githubLogin,
  workspaceLabel,
  returnTo,
  actionMessage,
  saving,
}: {
  outcome: Extract<SignInOutcomeView, { kind: "conflict" }>;
  state: string;
  githubLogin: string | null;
  workspaceLabel: string;
  returnTo: string;
  actionMessage: string | null;
  saving: boolean;
}) {
  return (
    <FormContainer
      title="Installation used by another workspace"
      eyebrow="GitHub access"
      description={`The GitHub App on ${installation.account} serves one Leyway workspace at a time.`}
    >
      <SignedInAs githubLogin={githubLogin} />
      {workspace ? (
        <>
          <p className="mt-3 text-sm text-[var(--bo-fg)]">
            The installation on <span className="font-semibold">{installation.account}</span> is
            linked to <span className="font-semibold">{workspace.label}</span>. Use its repositories
            there, or move the installation to {workspaceLabel}.
          </p>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            {`Moving disconnects every ${installation.account} repository linked in ${workspace.label}, and its automations that use them stop. Its GitHub webhooks come here instead.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Form method="post">
              <input type="hidden" name="intent" value="move" />
              <input type="hidden" name="state" value={state} />
              <Button variant="accent" type="submit" disabled={saving}>
                Move to {workspaceLabel}
              </Button>
            </Form>
            <ButtonLink variant="secondary" to={workspace.configurationPath}>
              Open GitHub in {workspace.label}
            </ButtonLink>
          </div>
          {actionMessage ? <p className="mt-3 text-xs text-red-500">{actionMessage}</p> : null}
        </>
      ) : (
        <p className="mt-3 text-sm text-[var(--bo-fg)]">
          The installation on <span className="font-semibold">{installation.account}</span> is
          linked to a Leyway workspace you are not a member of. Ask its admins to release it, or ask
          an admin of {installation.account} on GitHub to uninstall the app, then link it here.
        </p>
      )}
      <BackToLeyway returnTo={returnTo} />
    </FormContainer>
  );
}

function BoundOutcome({
  outcome: { installation, linked, missing, synced },
  githubLogin,
  returnTo,
}: {
  outcome: Extract<SignInOutcomeView, { kind: "bound" }>;
  githubLogin: string | null;
  returnTo: string;
}) {
  // A repository on another account cannot be added to this installation.
  const accountPrefix = `${installation.account.toLowerCase()}/`;
  const addable: string[] = [];
  const otherAccount: string[] = [];
  for (const fullName of missing) {
    (fullName.toLowerCase().startsWith(accountPrefix) ? addable : otherAccount).push(fullName);
  }
  return (
    <FormContainer
      title="GitHub installation linked"
      eyebrow="GitHub access"
      description={`The GitHub App on ${installation.account} now serves this workspace.`}
    >
      <SignedInAs githubLogin={githubLogin} />
      {linked.length > 0 ? (
        <p className="mt-3 text-sm text-[var(--bo-fg)]">Linked {linked.join(", ")}.</p>
      ) : null}
      {!synced ? (
        <p className="mt-3 text-sm text-[var(--bo-fg)]">
          Its repositories have not arrived from GitHub yet. Ask your agent to check the connection
          again in a minute.
        </p>
      ) : null}
      {synced && addable.length > 0 ? (
        <>
          <p className="mt-3 text-sm text-[var(--bo-fg)]">
            The installation cannot reach {addable.join(", ")}. Add{" "}
            {addable.length === 1 ? "it" : "them"} to the installation on GitHub, then ask your
            agent to check the connection again.
          </p>
          <a
            href={installation.url}
            target="_blank"
            rel="noreferrer"
            className={`mt-3 ${externalLinkClassName}`}
          >
            Open the installation on GitHub
          </a>
        </>
      ) : null}
      {synced && otherAccount.length > 0 ? (
        <p className="mt-3 text-sm text-[var(--bo-fg)]">
          {otherAccount.join(", ")} {otherAccount.length === 1 ? "belongs" : "belong"} to another
          GitHub account than {installation.account}. Ask your agent to set{" "}
          {otherAccount.length === 1 ? "it" : "them"} up again to install the app there.
        </p>
      ) : null}
      <BackToLeyway returnTo={returnTo} />
    </FormContainer>
  );
}
