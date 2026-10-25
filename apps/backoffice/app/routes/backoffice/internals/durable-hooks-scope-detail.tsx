import { ButtonLink } from "@fragno-private/design-system/button";
import { CodeBlock } from "@fragno-private/design-system/code-block";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useLocation, useOutletContext } from "react-router";

import type { DurableHookQueueEntry } from "@/fragno/durable-hooks";

import type { Route } from "./+types/durable-hooks-scope-detail";
import type { DurableHooksScopeOutletContext } from "./durable-hooks-scope-layout";
import { durableHookStatusTone, formatPayload, formatTimestamp } from "./durable-hooks-shared";

export default function BackofficeDurableHooksScopeDetail({ params }: Route.ComponentProps) {
  const { hooks, objectBasePath } = useOutletContext<DurableHooksScopeOutletContext>();
  const location = useLocation();
  const hook = hooks.find((item) => item.id === params.hookId) ?? null;

  if (!hook) {
    return (
      <BackofficeSystemState
        tone="empty"
        label="Durable hook"
        title="Select a hook to inspect it."
        description="Its attempts, error, and payload appear here."
      />
    );
  }

  return (
    <DurableHookDetailPanel hook={hook} backToListHref={`${objectBasePath}${location.search}`} />
  );
}

function DurableHookDetailPanel({
  hook,
  backToListHref,
}: {
  hook: DurableHookQueueEntry;
  backToListHref: string;
}) {
  return (
    <SurfacePanel
      caption="Durable hook"
      actions={
        <>
          <BackofficeStatusLight tone={durableHookStatusTone(hook.status)}>
            {hook.status}
          </BackofficeStatusLight>
          <ButtonLink to={backToListHref} variant="secondary" className="lg:hidden">
            Back to queue
          </ButtonLink>
        </>
      }
    >
      <SurfaceFacts
        items={[
          { key: "name", label: "Hook", value: hook.hookName },
          {
            key: "id",
            label: "ID",
            value: <span className="font-mono text-xs font-normal">{hook.id}</span>,
          },
          { key: "attempts", label: "Attempts", value: `${hook.attempts} / ${hook.maxAttempts}` },
          {
            key: "last",
            label: "Last attempt",
            value: formatTimestamp(hook.lastAttemptAt) || "Not attempted",
          },
          {
            key: "next",
            label: "Next retry",
            value: formatTimestamp(hook.nextRetryAt) || "Not scheduled",
          },
          { key: "created", label: "Created", value: formatTimestamp(hook.createdAt) || "Unknown" },
        ]}
      />
      <SurfacePanelBody>
        <div className="flex flex-col gap-3">
          {hook.error ? <InlineAlert>{hook.error}</InlineAlert> : null}
          <CodeBlock label="Payload" code={formatPayload(hook.payload) || "No payload recorded."} />
        </div>
      </SurfacePanelBody>
    </SurfacePanel>
  );
}
