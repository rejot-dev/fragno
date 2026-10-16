import "@fragno-private/design-system/components.css";

import type {
  AppActionsDeclaration,
  AppInstallationResourceScope,
} from "@fragno-dev/backoffice-api/v0/apps";
import { AuthorizationScreen } from "@fragno-private/design-system/authorization-screen";
import { Button } from "@fragno-private/design-system/button";
import { useState } from "react";
import {
  Form,
  data,
  isRouteErrorResponse,
  redirect,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";

import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";

import type { Route } from "./+types/app-install";
import {
  decideAppInstallation,
  describeAppPermissions,
  loadAppInstallChoices,
  resolveAppInstallRequest,
} from "./app-install.server";

const noStoreHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function requireInstallRequest(context: Route.LoaderArgs["context"], url: URL) {
  try {
    return await resolveAppInstallRequest(context, url);
  } catch (error) {
    if (error instanceof Error && error.name === "AppInstallRequestError") {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const user = await requireBackofficeBrowserSession(request, context);
  const installRequest = await requireInstallRequest(context, url);
  const choices = await loadAppInstallChoices(context, {
    userId: user.id,
    appId: installRequest.app.id,
    selectedOwner: url.searchParams.get("owner"),
  });
  return data(
    {
      userEmail: user.email,
      clientName: installRequest.client.name,
      requestedPermissions: describeAppPermissions(installRequest.app.requestedPermissions),
      actions: installRequest.app.actions,
      actionsRevision: installRequest.app.actionsRevision,
      returnOrigin: new URL(installRequest.redirectUri).origin,
      appRequest: {
        client_id: installRequest.client.clientId,
        redirect_uri: installRequest.redirectUri,
        state: installRequest.state,
      },
      ...choices,
    },
    { headers: noStoreHeaders },
  );
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const user = await requireBackofficeBrowserSession(request, context);
  const installRequest = await requireInstallRequest(context, url);
  const result = await decideAppInstallation(context, {
    userId: user.id,
    request: installRequest,
    formData: await request.formData(),
  });
  if (result.status === "invalid") {
    return data({ message: result.message }, { status: 400, headers: noStoreHeaders });
  }
  return redirect(result.location, { headers: noStoreHeaders });
}

export function headers() {
  return noStoreHeaders;
}

export function meta() {
  return [{ title: "Install application · Backoffice" }];
}

export default function BackofficeAppInstall({
  loaderData: install,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const pending = navigation.state !== "idle";
  const current = install.installation;
  const personal = install.selectedOwner.kind === "user";
  const grantedByDefault = (permission: string) =>
    current
      ? current.grantedPermissions.some(
          ({ namespace, permission: name }) => `${namespace}.${name}` === permission,
        )
      : true;

  return (
    <AuthorizationScreen
      title={`Install ${install.clientName}`}
      description={`${install.clientName} is asking to be installed for you or one of your organizations.`}
      eyebrow="Backoffice apps"
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--bo-muted)]">
          Signed in as <strong className="text-[var(--bo-fg)]">{install.userEmail}</strong>
        </p>
        {/* Native controls keep this consent screen usable without JavaScript, where the
            design-system pickers cannot be operated. */}
        <Form method="get" className="space-y-2">
          {/* Keep the app's request while switching where to install. */}
          {Object.entries(install.appRequest).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label className="block space-y-2 text-sm">
            <span className="font-semibold">Install for</span>
            <select
              name="owner"
              defaultValue={install.selectedOwner.value}
              className="bo-input min-h-11 w-full px-3 py-2 text-sm"
              onChange={(event) => {
                void submit(event.currentTarget.form);
              }}
            >
              {install.owners.map((owner) => (
                <option key={owner.value} value={owner.value}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>
          <noscript>
            <Button type="submit" variant="secondary">
              Switch
            </Button>
          </noscript>
        </Form>
        {current?.externalAccount ? (
          <p className="text-sm text-[var(--bo-muted)]">
            Already installed and linked to{" "}
            <strong className="text-[var(--bo-fg)]">{current.externalAccount.label}</strong>. To
            link a different account, uninstall the app first.
          </p>
        ) : null}
        <Form method="post" className="space-y-4" key={install.selectedOwner.value}>
          <input type="hidden" name="owner" value={install.selectedOwner.value} />
          <input type="hidden" name="actionsRevision" value={install.actionsRevision} />
          <fieldset className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
            <legend className="px-1 text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Permissions
            </legend>
            {install.requestedPermissions.length === 0 ? (
              <p className="text-sm text-[var(--bo-muted)]">This app requests no permissions.</p>
            ) : (
              install.requestedPermissions.map(({ permission, operations }) => (
                <div key={permission} className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="permission"
                      value={permission}
                      defaultChecked={grantedByDefault(permission)}
                    />
                    <span className="font-mono">{permission}</span>
                  </label>
                  {operations.length === 0 ? (
                    <p className="pl-6 text-xs text-[var(--bo-muted)]">
                      No API operation uses this permission yet.
                    </p>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-10 text-xs leading-5 text-[var(--bo-muted)]">
                      {operations.map((operation) => (
                        <li key={operation}>{operation}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </fieldset>
          <ActionsSummary
            actions={install.actions}
            pendingApproval={
              current !== null && current.approvedActionsRevision !== install.actionsRevision
            }
            personal={personal}
          />
          <ResourceFields
            projects={install.projects}
            current={current?.resourceScope ?? null}
            personal={personal}
          />
          <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            {personal
              ? `${install.clientName} can then act for you within the access above: as itself, and on your behalf when you authorize it.`
              : `${install.clientName} can then act in this organization within the access above: as itself, and on behalf of members who authorize it, limited to what those members may do.`}{" "}
            You can change or remove this installation at any time.
          </p>
          <dl className="text-xs text-[var(--bo-muted)]">
            <dt>Returns to</dt>
            <dd className="mt-1 break-all">{install.returnOrigin}</dd>
          </dl>
          {actionData ? (
            <p role="alert" className="text-sm text-[var(--bo-failed)]">
              {actionData.message}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="accent" type="submit" name="intent" value="install" disabled={pending}>
              {pending ? "Installing…" : current ? "Update installation" : "Install"}
            </Button>
            <Button
              variant="secondary"
              type="submit"
              name="intent"
              value="cancel"
              formNoValidate
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </Form>
      </div>
    </AuthorizationScreen>
  );
}

/** Actions are approved as a whole: the app serves them, so there is nothing to select. */
function ActionsSummary({
  actions,
  pendingApproval,
  personal,
}: {
  actions: AppActionsDeclaration;
  pendingApproval: boolean;
  personal: boolean;
}) {
  if (actions.kind === "none") {
    return null;
  }
  return (
    <fieldset className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
      <legend className="px-1 text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        Actions
      </legend>
      <p className="text-sm text-[var(--bo-muted)]">
        {personal ? "You and your agents" : "Members and agents in this organization"} can call
        these actions, which run on{" "}
        <span className="break-all">{new URL(actions.endpointUrl).origin}</span>.
        {actions.changeApproval === "automatic"
          ? " Changes to them apply without approving them again."
          : " Changes to them need your approval before they run."}
      </p>
      {pendingApproval ? (
        <p className="text-sm text-[var(--bo-fg)]">
          These actions changed since this installation was approved.
        </p>
      ) : null}
      <ul className="space-y-1 text-sm">
        {actions.actions.map((action) => (
          <li key={action.id}>
            <span className="font-semibold">{action.label}</span>{" "}
            <span className="font-mono text-xs text-[var(--bo-muted)]">{action.id}</span>
            <p className="text-xs leading-5 text-[var(--bo-muted)]">{action.description}</p>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Keyed by owner through its form, so switching owners resets the selection. */
function ResourceFields({
  projects,
  current,
  personal,
}: {
  projects: { id: string; name: string }[];
  current: AppInstallationResourceScope | null;
  personal: boolean;
}) {
  const [resources, setResources] = useState<AppInstallationResourceScope["kind"]>(
    current?.kind ?? "owner",
  );
  return (
    <fieldset className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
      <legend className="px-1 text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        Access to
      </legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="resources"
          value="owner"
          checked={resources === "owner"}
          onChange={() => {
            setResources("owner");
          }}
        />
        {personal ? "Your whole personal workspace" : "The whole organization"}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="resources"
          value="projects"
          checked={resources === "projects"}
          disabled={projects.length === 0}
          onChange={() => {
            setResources("projects");
          }}
        />
        Selected projects
      </label>
      {resources === "projects" ? (
        <div className="space-y-1 pl-6">
          {projects.map((project) => (
            <label key={project.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="projectId"
                value={project.id}
                defaultChecked={
                  current?.kind === "projects" && current.projectIds.includes(project.id)
                }
              />
              {project.name}
            </label>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <AuthorizationScreen
      title="Installation unavailable"
      description="Return to the application and start the installation again."
      eyebrow="Backoffice apps"
    >
      <p role="alert" className="text-sm text-[var(--bo-failed)]">
        {isRouteErrorResponse(error) && typeof error.data === "string"
          ? error.data
          : "This installation request could not be loaded."}
      </p>
    </AuthorizationScreen>
  );
}
