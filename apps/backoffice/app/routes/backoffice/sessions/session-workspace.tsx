import { Suspense, use, useCallback, useState } from "react";
import { Outlet, useActionData, useNavigation, useParams } from "react-router";

import {
  backofficeContextScopeRoutePath,
  backofficeContextScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import { BackofficeSystemState } from "@/components/backoffice";
import { ClientOnly } from "@/components/client-only";
import { getAutomationBrowserDatabase } from "@/fragno/automation/tanstack/browser-database";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";
import type { PiSessionListingState } from "@/fragno/pi/tanstack/session-listing";
import { usePiSessionListing } from "@/fragno/pi/tanstack/use-session-listing";

import { MobileSessionStrip } from "./mobile-session-strip";
import { NewSessionComposer } from "./new-session-composer";
import {
  updateSessionWorkspaceStateBySession,
  type SessionWorkspaceStateBySession,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import { SessionListSplit } from "./session-list-split";
import { SessionSidebar } from "./session-sidebar";
import type { PiCreateSessionActionData, PiSessionsOutletContext } from "./session-types";
import type { PiLayoutContext } from "./shared";

const PI_SESSIONS_LOADING = <PiSessionsLoading />;

export function PiSessionsWorkspace({ layoutContext }: { layoutContext: PiLayoutContext }) {
  if (!layoutContext.persistenceSource) {
    return <PiSessionsUnavailable layoutContext={layoutContext} />;
  }

  return (
    <ClientOnly fallback={PI_SESSIONS_LOADING}>
      <Suspense fallback={PI_SESSIONS_LOADING}>
        <SynchronizedPiSessionsWorkspace
          layoutContext={layoutContext}
          source={layoutContext.persistenceSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function PiSessionsLoading() {
  return (
    <BackofficeSystemState
      tone="loading"
      label="Opening sessions"
      title="Synchronizing…"
      description="Loading local session state."
    />
  );
}

function PiSessionsUnavailable({ layoutContext }: { layoutContext: PiLayoutContext }) {
  const message =
    layoutContext.runtimeError ??
    layoutContext.persistenceError ??
    (layoutContext.runtimeState?.configured
      ? "Local session persistence is unavailable."
      : "Set a Pi provider API key in .dev.vars.");

  return (
    <BackofficeSystemState
      tone="empty"
      label="Unavailable"
      title="Sessions are not connected."
      description={message}
    />
  );
}

function SynchronizedPiSessionsWorkspace({
  layoutContext,
  source,
}: {
  layoutContext: PiLayoutContext;
  source: NonNullable<PiLayoutContext["persistenceSource"]>;
}) {
  const listingState = usePiSessionListing({
    source,
    workflowName: BACKOFFICE_PI_WORKFLOW_NAME,
  });
  const automationDatabase = use(getAutomationBrowserDatabase());
  const workflowCollections = layoutContext.automationPersistenceSource
    ? automationDatabase.collectionsFor(layoutContext.automationPersistenceSource)
    : undefined;

  if (listingState.status === "synchronizing" && listingState.snapshot.sessions.length === 0) {
    return <PiSessionsLoading />;
  }

  return (
    <PiSessionsWorkspaceView
      layoutContext={layoutContext}
      source={source}
      listingState={listingState}
      workflowCollections={workflowCollections}
    />
  );
}

function PiSessionsWorkspaceView({
  layoutContext,
  source,
  listingState,
  workflowCollections,
}: {
  layoutContext: PiLayoutContext;
  source: NonNullable<PiLayoutContext["persistenceSource"]>;
  listingState: PiSessionListingState;
  workflowCollections: PiSessionsOutletContext["workflowCollections"];
}) {
  const actionData = useActionData() as PiCreateSessionActionData | undefined;
  const navigation = useNavigation();
  const { sessionId, workflowName } = useParams();
  const { scope, runtimeState } = layoutContext;
  const basePath = `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`;
  const { sessions, workflowStatuses } = listingState.snapshot;
  const listingError = listingState.status === "error" ? listingState.error : null;
  const creating =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create-session";
  const availableModelOptions = runtimeState?.modelCatalog ?? [];

  const [preferredModelOption, setPreferredModelOption] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [workspaceStates, setWorkspaceStates] = useState<SessionWorkspaceStateBySession>({});
  const updateWorkspaceState = useCallback(
    (sessionKey: string, update: SessionWorkspaceStateUpdate) => {
      setWorkspaceStates((current) =>
        updateSessionWorkspaceStateBySession(current, sessionKey, update),
      );
    },
    [],
  );

  const selectedModelOption = availableModelOptions.some(
    (option) => `${option.provider}::${option.name}` === preferredModelOption,
  )
    ? preferredModelOption
    : availableModelOptions[0]
      ? `${availableModelOptions[0].provider}::${availableModelOptions[0].name}`
      : "";
  const createError =
    actionData?.intent === "create-session" && !actionData.ok ? (actionData.message ?? null) : null;

  const startNewSession = () => {
    setDraftPrompt("");
  };

  const createSessionPanel = (
    <NewSessionComposer
      availableModelOptions={availableModelOptions}
      basePath={basePath}
      createError={createError}
      creating={creating}
      draftPrompt={draftPrompt}
      selectedModelOption={selectedModelOption}
      onDraftPromptChange={setDraftPrompt}
      onModelChange={setPreferredModelOption}
    />
  );

  return (
    <SessionListSplit
      storageKey={`backoffice:pi-session-list-width:${backofficeContextScopeSinglePathSegment(scope)}`}
      mobileNavigation={
        <MobileSessionStrip
          basePath={basePath}
          selectedSessionId={sessionId ?? null}
          selectedWorkflowName={workflowName ?? null}
          sessions={sessions}
          workflowStatuses={workflowStatuses}
          onNewChat={startNewSession}
        />
      }
      sidebar={
        <SessionSidebar
          basePath={basePath}
          listingError={listingError}
          selectedSessionId={sessionId ?? null}
          selectedWorkflowName={workflowName ?? null}
          sessions={sessions}
          workflowStatuses={workflowStatuses}
          onNewChat={startNewSession}
        />
      }
    >
      <Outlet
        context={{
          scope,
          persistenceSource: source,
          basePath,
          createSessionPanel,
          workspaceStates,
          updateWorkspaceState,
          workflowCollections,
          workflowCollectionsError: layoutContext.automationPersistenceError,
        }}
      />
    </SessionListSplit>
  );
}
