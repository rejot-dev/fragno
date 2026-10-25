import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { Link, useOutletContext } from "react-router";

import { internalsScopeBasePath } from "./internals-scope";
import type { InternalsLayoutContext } from "./layout";

type InternalDestination = {
  id: string;
  name: string;
  description: string;
  to: string | null;
};

const COLUMNS: SurfaceTableColumn[] = [
  { label: "Tool", align: "start" },
  { label: "What it covers", align: "start" },
  { label: "Status", align: "end" },
];

function internalDestinations(
  hasOrganization: boolean,
  internalsBasePath: string,
): InternalDestination[] {
  return [
    {
      id: "users",
      name: "Users",
      description: "Review every system account and manage global administrator access.",
      to: `${internalsBasePath}/users`,
    },
    {
      id: "github",
      name: "GitHub",
      description:
        "Inspect GitHub App runtime configuration and singleton installation routing state.",
      to: `${internalsBasePath}/github`,
    },
    {
      id: "cloudflare-browser-run",
      name: "Cloudflare Browser Run",
      description: "Create Browser Run sessions and exercise their target lifecycle APIs.",
      to: `${internalsBasePath}/cloudflare/browser-run`,
    },
    {
      id: "generated-ui",
      name: "Generated UI",
      description:
        "Preview every component and semantic variant in the production codemode presentation catalog.",
      to: `${internalsBasePath}/generated-ui`,
    },
    {
      id: "upload",
      name: "Upload",
      description: "Configure upload storage and inspect organization-scoped upload operations.",
      to: hasOrganization ? "/backoffice/connections/upload" : null,
    },
    {
      id: "durable-hooks",
      name: "Durable hooks",
      description:
        "Inspect durable hook queues and retry state across organization and singleton scopes.",
      to: `${internalsBasePath}/durable-hooks`,
    },
    {
      id: "codemode",
      name: "Codemode runs",
      description:
        "Review codemode runs in this scope and the tool calls each one made, with their input and output.",
      to: `${internalsBasePath}/codemode`,
    },
    {
      id: "workflows",
      name: "Workflows",
      description:
        "Inspect workflow instances, state transitions, and step/event history by fragment.",
      to: `${internalsBasePath}/workflows`,
    },
  ];
}

export function meta() {
  return [
    { title: "Backoffice Internals" },
    { name: "description", content: "Monitor internal backoffice services and queues." },
  ];
}

export default function BackofficeInternals() {
  const { me, selectedRouteScope } = useOutletContext<InternalsLayoutContext>();
  const destinations = internalDestinations(
    me.organizations.length > 0,
    internalsScopeBasePath(selectedRouteScope),
  );

  return (
    <SurfacePanel caption={`${destinations.length} internal tools`} actions={null}>
      <SurfaceTable columns={COLUMNS}>
        {destinations.map((item) => (
          <SurfaceTableRow
            key={item.id}
            columns={COLUMNS}
            cells={[
              item.to === null ? (
                <span key="name" className="font-semibold whitespace-nowrap text-[var(--bo-muted)]">
                  {item.name}
                </span>
              ) : (
                <Link
                  key="name"
                  to={item.to}
                  className="font-semibold whitespace-nowrap text-[var(--bo-fg)] hover:underline"
                >
                  {item.name}
                </Link>
              ),
              <span key="description" className="text-pretty">
                {item.description}
              </span>,
              item.to === null ? (
                <BackofficeStatusLight key="status" tone="waiting">
                  Needs an organization
                </BackofficeStatusLight>
              ) : (
                <BackofficeStatusLight key="status" tone="live">
                  Available
                </BackofficeStatusLight>
              ),
            ]}
          />
        ))}
      </SurfaceTable>
    </SurfacePanel>
  );
}
