import { useCallback, useEffect, useState } from "react";
import { Outlet, useActionData, useNavigation, useRevalidator } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

import type { PiManagerSessionsResult } from "./data";
import { NewSessionComposer } from "./new-session-composer";
import {
  updateSessionWorkspaceStateBySession,
  type SessionWorkspaceStateBySession,
  type SessionWorkspaceStateUpdate,
} from "./session-detail/workspace-model";
import { SessionListSplit } from "./session-list-split";
import type { PiCreateSessionActionData } from "./session-types";
import type { PiLayoutContext } from "./shared";

const SESSION_LIST_REFRESH_MS = 10_000;

export function PiSessionsWorkspace({
  layoutContext,
  listing,
}: {
  layoutContext: PiLayoutContext;
  listing: PiManagerSessionsResult;
}) {
  const actionData = useActionData() as PiCreateSessionActionData | undefined;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const { resolvedScope, availableModelOptions } = layoutContext;
  const basePath = `/backoffice/sessions/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
  )}/sessions`;
  const creating =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create-session";

  const [preferredModelOption, setPreferredModelOption] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [workspaceStates, setWorkspaceStates] = useState<SessionWorkspaceStateBySession>({});
  const updateWorkspaceState = useCallback(
    (sessionId: string, update: SessionWorkspaceStateUpdate) => {
      setWorkspaceStates((current) =>
        updateSessionWorkspaceStateBySession(current, sessionId, update),
      );
    },
    [],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, SESSION_LIST_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [revalidator]);

  const selectedModelOption = availableModelOptions.some(
    (option) => `${option.provider}::${option.modelId}` === preferredModelOption,
  )
    ? preferredModelOption
    : availableModelOptions[0]
      ? `${availableModelOptions[0].provider}::${availableModelOptions[0].modelId}`
      : "";
  const createError =
    actionData?.intent === "create-session" && !actionData.ok ? (actionData.message ?? null) : null;
  const startNewSession = useCallback(() => {
    setDraftPrompt("");
  }, []);

  const createSessionPanel = (
    <NewSessionComposer
      availableModelOptions={availableModelOptions}
      basePath={basePath}
      billingOrganization={layoutContext.billingOrganization}
      createError={createError}
      creating={creating}
      draftPrompt={draftPrompt}
      selectedModelOption={selectedModelOption}
      onDraftPromptChange={setDraftPrompt}
      onModelChange={setPreferredModelOption}
      listingError={listing.sessionsError}
      sessions={listing.sessions}
    />
  );

  return (
    <SessionListSplit>
      <Outlet
        context={{
          resolvedScope,
          availableModelOptions,
          basePath,
          createSessionPanel,
          startNewSession,
          sessions: listing.sessions,
          sessionsError: listing.sessionsError,
          workspaceStates,
          updateWorkspaceState,
        }}
      />
    </SessionListSplit>
  );
}
