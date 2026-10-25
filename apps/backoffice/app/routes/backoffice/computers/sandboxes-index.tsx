import { ButtonLink } from "@fragno-private/design-system/button";
import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useOutletContext } from "react-router";

import type { SandboxesLayoutContext } from "./layout-context";
import { newSandboxPath, sandboxPath } from "./paths";
import { SandboxActivity, SandboxStatusLight } from "./sandbox-status";

const COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Sandbox", align: "start" },
  { label: "Status", align: "start" },
  { label: "Image", align: "start" },
  { label: "Size", align: "start" },
  { label: "Workspace", align: "start" },
  { label: "Activity", align: "start" },
];

export default function BackofficeSandboxesIndex() {
  const { routeScope, sandboxes } = useOutletContext<SandboxesLayoutContext>();
  const newSandbox = (
    <ButtonLink variant="accent" to={newSandboxPath(routeScope)}>
      New sandbox
    </ButtonLink>
  );

  return (
    <SurfacePanel
      caption={`${sandboxes.length} ${sandboxes.length === 1 ? "sandbox" : "sandboxes"}`}
      actions={sandboxes.length > 0 ? newSandbox : null}
    >
      {sandboxes.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title="No sandboxes yet."
          description="Sandboxes are isolated Cloudflare containers for running commands. Agents start them too."
          actions={newSandbox}
          flush
        />
      ) : (
        <SurfaceTable columns={COLUMNS}>
          {sandboxes.map((sandbox) => (
            <SurfaceTableRow
              key={sandbox.id}
              columns={COLUMNS}
              cells={[
                <Link
                  key="id"
                  to={sandboxPath(routeScope, sandbox.id)}
                  title={sandbox.id}
                  className="block max-w-[22rem] truncate font-mono font-semibold text-[var(--bo-fg)] hover:underline"
                >
                  {sandbox.id}
                </Link>,
                <SandboxStatusLight key="status" status={sandbox.status} />,
                <span key="image" className="whitespace-nowrap">
                  {sandbox.image}
                </span>,
                <span key="size" className="whitespace-nowrap">
                  {sandbox.instanceType}
                </span>,
                <span key="workspace" className="whitespace-nowrap">
                  {sandbox.workspaceSaved ? "Saved" : "—"}
                </span>,
                <span
                  key="activity"
                  className={`block max-w-[24rem] truncate text-xs whitespace-nowrap ${
                    sandbox.status === "error" ? "text-[var(--bo-failed)]" : ""
                  }`}
                >
                  <SandboxActivity sandbox={sandbox} />
                </span>,
              ]}
            />
          ))}
        </SurfaceTable>
      )}
    </SurfacePanel>
  );
}
