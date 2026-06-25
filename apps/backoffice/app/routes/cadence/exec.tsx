import { redirect, useOutletContext } from "react-router";

import { Prompt, PromptOutput, PromptProvider, usePrompt } from "@/components/cadence";
import { CodemodeWorkflowPanel } from "@/components/cadence/prompt/codemode-workflow-panel";
import { WorkflowPanel } from "@/components/cadence/prompt/workflow-panel";
import { ResizableSplit } from "@/components/cadence/resizable-split";
import { getAuthMe } from "@/fragno/auth/auth-server";
import type { CadenceLayoutContext } from "@/layouts/cadence-layout";
import { cn } from "@/lib/utils";
import { handlePiTerminalAction } from "@/routes/backoffice/pi-terminal-action";

import type { Route } from "./+types/exec";
import { handleComposeAction } from "./compose-action";

/** Fill the whole main area so the workflow panel can run full-height. */
export const handle = { fullBleed: true };

/**
 * Server side of the prompt. Two surfaces post here:
 *
 *   - `compose` — plain-language drafts, planned into a typed output stream.
 *   - the dev terminal — bash commands and path completion, shared with the
 *     backoffice dashboard terminal and scoped to the active organisation.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect("/backoffice/login");
  }

  const formData = await request.formData();
  const activeOrg = me.activeOrganization?.organization ?? null;

  if (formData.get("intent") === "compose") {
    return handleComposeAction({
      formData,
      request,
      context,
      orgId: activeOrg?.id ?? null,
    });
  }

  return handlePiTerminalAction({
    formData,
    request,
    context,
    activeOrg,
    userId: me.user.id,
  });
}

export default function ExecPage() {
  const { me } = useOutletContext<CadenceLayoutContext>();
  const activeOrg = me?.activeOrganization?.organization ?? null;

  return (
    <PromptProvider organizationId={activeOrg?.id} organizationName={activeOrg?.name}>
      <ExecWorkspace />
    </PromptProvider>
  );
}

/**
 * The exec surface: the conversation, and — when the agent surfaces a workflow —
 * a resizable companion panel beside it. Without a workflow the conversation is
 * centered and full-width; with one, it moves into the left column of a split.
 */
function ExecWorkspace() {
  const { compose, closeWorkflow, workflowRefreshToken, selectCodemodeTab, organizationId } =
    usePrompt();
  const workspace = compose.workspace;
  const hasPanel = workspace.kind !== "none";

  // Always render a single ResizableSplit with the conversation on the left. The
  // panel is added/removed as the right pane — which keeps the conversation (and
  // its live Pi session, scroll, and tool-call de-dupe) mounted across the toggle.
  return (
    <ResizableSplit
      storageKey="cad-exec-workflow-split"
      left={<Conversation className={hasPanel ? undefined : "mx-auto max-w-4xl"} />}
      right={
        workspace.kind === "workflow" ? (
          <WorkflowPanel
            key={workspace.name}
            name={workspace.name}
            mode={workspace.mode}
            refreshToken={workflowRefreshToken}
            onClose={closeWorkflow}
          />
        ) : workspace.kind === "codemode" ? (
          <CodemodeWorkflowPanel
            entries={workspace.entries}
            activeIndex={workspace.activeIndex}
            orgId={organizationId ?? null}
            onSelectTab={selectCodemodeTab}
            onClose={closeWorkflow}
          />
        ) : null
      }
    />
  );
}

/** The conversation column: the output block above, the prompt input pinned below. */
function Conversation({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col px-4 py-6", className)}>
      <PromptOutput />
      <div className="mt-auto shrink-0 pt-4">
        <Prompt />
      </div>
    </div>
  );
}
