import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import { Suspense, useMemo, useState } from "react";
import { Outlet, useActionData, useNavigation, useParams } from "react-router";

import { BackofficeSystemState } from "@/components/backoffice";
import { ClientOnly } from "@/components/client-only";
import { PI_MODEL_CATALOG, resolvePiHarnesses } from "@/fragno/pi/pi-shared";
import type { PiSessionListingState } from "@/fragno/pi/tanstack/session-listing";
import { usePiSessionListing } from "@/fragno/pi/tanstack/use-session-listing";

import { MobileSessionStrip } from "./mobile-session-strip";
import { NewSessionComposer } from "./new-session-composer";
import { SessionSidebar } from "./session-sidebar";
import type { PiCreateSessionActionData } from "./session-types";
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
    layoutContext.configError ??
    layoutContext.persistenceError ??
    (layoutContext.configState?.configured
      ? "Local session persistence is unavailable."
      : "Configure Pi first.");

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
    workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
  });

  if (listingState.status === "synchronizing" && listingState.snapshot.sessions.length === 0) {
    return <PiSessionsLoading />;
  }

  return (
    <PiSessionsWorkspaceView
      layoutContext={layoutContext}
      source={source}
      listingState={listingState}
    />
  );
}

function PiSessionsWorkspaceView({
  layoutContext,
  source,
  listingState,
}: {
  layoutContext: PiLayoutContext;
  source: NonNullable<PiLayoutContext["persistenceSource"]>;
  listingState: PiSessionListingState;
}) {
  const actionData = useActionData() as PiCreateSessionActionData | undefined;
  const navigation = useNavigation();
  const { sessionId, workflowName } = useParams();
  const { scope, configState } = layoutContext;
  const basePath = `/backoffice/sessions/${encodeURIComponent(scope.orgId)}/sessions`;
  const { sessions, workflowStatuses } = listingState.snapshot;
  const listingError = listingState.status === "error" ? listingState.error : null;
  const creating =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create-session";
  const harnesses = resolvePiHarnesses(configState?.config?.harnesses);
  const apiKeys = configState?.config?.apiKeys;
  const availableModelOptions = useMemo(
    () => PI_MODEL_CATALOG.filter((option) => Boolean(apiKeys?.[option.provider])),
    [apiKeys],
  );

  const [preferredHarnessId, setPreferredHarnessId] = useState("");
  const [preferredModelOption, setPreferredModelOption] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");

  const selectedHarnessId = harnesses.some((harness) => harness.id === preferredHarnessId)
    ? preferredHarnessId
    : (harnesses[0]?.id ?? "");
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
      harnesses={harnesses}
      selectedHarnessId={selectedHarnessId}
      selectedModelOption={selectedModelOption}
      onDraftPromptChange={setDraftPrompt}
      onHarnessChange={setPreferredHarnessId}
      onModelChange={setPreferredModelOption}
    />
  );

  return (
    <section className="bo-fragment-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] lg:flex-row">
      <MobileSessionStrip
        basePath={basePath}
        selectedSessionId={sessionId ?? null}
        selectedWorkflowName={workflowName ?? null}
        sessions={sessions}
        workflowStatuses={workflowStatuses}
        onNewChat={startNewSession}
      />

      <SessionSidebar
        basePath={basePath}
        listingError={listingError}
        selectedSessionId={sessionId ?? null}
        selectedWorkflowName={workflowName ?? null}
        sessions={sessions}
        workflowStatuses={workflowStatuses}
        onNewChat={startNewSession}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bo-panel)]">
        <Outlet
          context={{
            scope,
            persistenceSource: source,
            harnesses,
            basePath,
            createSessionPanel,
          }}
        />
      </main>
    </section>
  );
}
