import { IconButton, IconButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/pane-message";
import { Select } from "@fragno-private/design-system/select";
import { SideDrawer, SideDrawerHeader } from "@fragno-private/design-system/side-drawer";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { formatPiAgentName, MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import { AgentConversation } from "@/routes/backoffice/agents/agent-conversation";
import type { loader as agentDrawerLoader } from "@/routes/backoffice/agents/agent-drawer-data";
import { AgentStartComposer } from "@/routes/backoffice/agents/agent-start-composer";
import type { PiAgentDirectoryState } from "@/routes/backoffice/agents/agent-types";
import { usePiAgentDirectory } from "@/routes/backoffice/agents/agents-workspace";
import { piAgentsPath } from "@/routes/backoffice/agents/path";

export const AGENT_DRAWER_ID = "agent-drawer";

/** A conversation with one of the scope's agents beside every page, starting with the main agent. */
export function AgentDrawer({
  open,
  resolvedScope,
  onClose,
}: {
  open: boolean;
  /** Null where the page has no scope to hold agents. */
  resolvedScope: BackofficeResolvedScope | null;
  onClose: () => void;
}) {
  // The choice belongs to the scope it was made in; another scope starts with its main agent.
  const [selection, setSelection] = useState<{ agentsPath: string; agentName: string } | null>(
    null,
  );
  const agentsPath = resolvedScope
    ? piAgentsPath(backofficeRouteScopeFromResolvedScope(resolvedScope))
    : null;
  const agentName = selection?.agentsPath === agentsPath ? selection.agentName : MAIN_PI_AGENT_NAME;

  return (
    <SideDrawer
      id={AGENT_DRAWER_ID}
      label="Agent conversation"
      open={open}
      storageKey="backoffice:agent-drawer-width"
    >
      {resolvedScope && agentsPath ? (
        <AgentDrawerScope
          key={`${agentsPath}/${agentName}`}
          open={open}
          resolvedScope={resolvedScope}
          agentsPath={agentsPath}
          agentName={agentName}
          onAgentChange={(nextAgentName) => {
            setSelection({ agentsPath, agentName: nextAgentName });
          }}
          onClose={onClose}
        />
      ) : (
        <>
          <AgentDrawerHeader options={null} onClose={onClose} />
          <PaneMessage tone="muted">Agents are unavailable on this page.</PaneMessage>
        </>
      )}
    </SideDrawer>
  );
}

function AgentDrawerScope({
  open,
  resolvedScope,
  agentsPath,
  agentName,
  onAgentChange,
  onClose,
}: {
  open: boolean;
  resolvedScope: BackofficeResolvedScope;
  agentsPath: string;
  agentName: string;
  onAgentChange: (agentName: string) => void;
  onClose: () => void;
}) {
  const directory = usePiAgentDirectory();
  const agentPath = `${agentsPath}/${encodeURIComponent(agentName)}`;
  const { state, reload } = useAgentDrawerData(`${agentPath}/drawer`, open);

  const header = (options: ReactNode | null) => (
    <AgentDrawerHeader
      options={
        <>
          <AgentSelect directory={directory} agentName={agentName} onChange={onAgentChange} />
          <IconButtonLink to={agentPath} label={`Open ${formatPiAgentName(agentName)}`}>
            <Icon name="maximize-2" className="size-4" />
          </IconButtonLink>
          {options}
        </>
      }
      onClose={onClose}
    />
  );

  if (state.status !== "ready") {
    return (
      <>
        {header(null)}
        {state.status === "loading" ? (
          <PaneSpinner label="Loading agent" />
        ) : (
          <PaneMessage tone="failed">{state.message}</PaneMessage>
        )}
      </>
    );
  }
  const { data } = state;
  if (!data.lookup.found) {
    return (
      <>
        {header(null)}
        <PaneMessage tone="failed">{data.lookup.message}</PaneMessage>
      </>
    );
  }
  const { agent } = data.lookup;
  if (!agent.provisioned) {
    return (
      <>
        {header(null)}
        <div className="backoffice-scroll-invisible flex min-h-0 flex-1 flex-col overflow-y-auto">
          <AgentStartComposer
            action={agentPath}
            agentName={agent.agentName}
            builtIn={agent.steward.kind === "backoffice"}
            availableModelOptions={data.availableModelOptions}
            description={agent.description}
            permissions={agent.permissions}
            usageLabel={data.usageLabel}
            resolvedScope={resolvedScope}
            onStarted={reload}
          />
        </div>
      </>
    );
  }
  return (
    <AgentConversation
      agent={agent}
      agentPath={agentPath}
      availableModelOptions={data.availableModelOptions}
      dictationMountRoute={data.dictationMountRoute}
      header={header}
      // The drawer is too narrow to open what the conversation produced beside it.
      workspace={null}
      resolvedScope={resolvedScope}
    />
  );
}

type AgentDrawerData = Awaited<ReturnType<typeof agentDrawerLoader>>;

type AgentDrawerDataState =
  | { status: "loading" }
  | { status: "ready"; data: AgentDrawerData }
  | { status: "failed"; message: string };

/**
 * Read outside the router, like the agents' other resource routes: a fetcher's first load that a
 * navigation interrupts is not retried until the router has discovered the route, which left the
 * drawer loading forever.
 */
function useAgentDrawerData(url: string, open: boolean) {
  const [state, setState] = useState<AgentDrawerDataState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  // The drawer stays mounted while closed, so an agent started meanwhile on its own page would
  // still show the first-turn composer. A started agent is not reloaded, which keeps its stream.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (
      open &&
      state.status === "ready" &&
      state.data.lookup.found &&
      !state.data.lookup.agent.provisioned
    ) {
      setReloads((count) => count + 1);
    }
  }

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    async function loadAgentDrawerData() {
      try {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`The agent could not be loaded (status ${response.status}).`);
        }
        // This application-owned resource route returns its loader data unchanged.
        const data = (await response.json()) as AgentDrawerData;
        if (!ignore) {
          setState({ status: "ready", data });
        }
      } catch (cause) {
        if (!ignore) {
          setState({
            status: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    void loadAgentDrawerData();
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [url, reloads]);

  const reload = useCallback(() => {
    setReloads((count) => count + 1);
  }, []);
  return { state, reload };
}

function AgentDrawerHeader({ options, onClose }: { options: ReactNode; onClose: () => void }) {
  return (
    <SideDrawerHeader>
      <div className="flex min-w-0 flex-1 items-center gap-1">{options}</div>
      <IconButton label="Close agent drawer" onClick={onClose}>
        <Icon name="x" className="size-4" />
      </IconButton>
    </SideDrawerHeader>
  );
}

function AgentSelect({
  directory,
  agentName,
  onChange,
}: {
  directory: PiAgentDirectoryState;
  agentName: string;
  onChange: (agentName: string) => void;
}) {
  // Until the directory is read, the selected agent is the only one known.
  const agentNames =
    directory.status === "ready"
      ? directory.agents.map(({ definition }) => definition.agentName)
      : [agentName];
  return (
    <Select
      aria-label="Agent"
      density="compact"
      className="max-w-56 min-w-0"
      value={agentName}
      options={agentNames.map((name) => ({ label: formatPiAgentName(name), value: name }))}
      onValueChange={(value) => {
        if (value !== null) {
          onChange(value);
        }
      }}
    />
  );
}
