import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useOutletContext } from "react-router";

import type { SandboxesLayoutContext } from "./layout-context";
import { newSandboxPath, sandboxPath } from "./paths";
import { SandboxActivity, SandboxStatusLight } from "./sandbox-status";

const COLUMNS = ["Sandbox", "Status", "Image", "Size", "Workspace", "Activity"];

export default function BackofficeSandboxesIndex() {
  const { routeScope, sandboxes } = useOutletContext<SandboxesLayoutContext>();
  const newSandbox = (
    <ButtonLink variant="accent" to={newSandboxPath(routeScope)}>
      New sandbox
    </ButtonLink>
  );

  return (
    <section className="bo-panel-surface bg-[var(--bo-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          {sandboxes.length} {sandboxes.length === 1 ? "sandbox" : "sandboxes"}
        </p>
        {sandboxes.length > 0 ? newSandbox : null}
      </div>
      {sandboxes.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title="No sandboxes yet."
          description="Sandboxes are isolated Cloudflare containers for running commands. Agents start them too."
          actions={newSandbox}
          flush
        />
      ) : (
        <div className="backoffice-scroll overflow-x-auto border-t border-[color:var(--bo-border)]">
          <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
            <thead className="bg-[var(--bo-panel-2)] text-left">
              <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                {COLUMNS.map((heading) => (
                  <th key={heading} scope="col" className="px-4 py-2 font-normal whitespace-nowrap">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--bo-border)]">
              {sandboxes.map((sandbox) => (
                <tr key={sandbox.id} className="hover:bg-[var(--bo-panel-2)]">
                  <td className="max-w-[22rem] px-4 py-2.5">
                    <Link
                      to={sandboxPath(routeScope, sandbox.id)}
                      title={sandbox.id}
                      className="block truncate font-mono font-semibold text-[var(--bo-fg)] hover:underline"
                    >
                      {sandbox.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <SandboxStatusLight status={sandbox.status} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-[var(--bo-muted)]">
                    {sandbox.image}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-[var(--bo-muted)]">
                    {sandbox.instanceType}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-[var(--bo-muted)]">
                    {sandbox.workspaceSaved ? "Saved" : "—"}
                  </td>
                  <td
                    className={`max-w-[24rem] truncate px-4 py-2.5 text-xs whitespace-nowrap ${
                      sandbox.status === "error"
                        ? "text-[var(--bo-failed)]"
                        : "text-[var(--bo-muted)]"
                    }`}
                  >
                    <SandboxActivity sandbox={sandbox} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
