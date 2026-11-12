import type { ReactNode } from "react";
import { Link } from "react-router";

import { IconButtonLink } from "../controls/button";
import { BackofficeStatusLight } from "../feedback/status-light";
import { Icon, type IconName } from "../icon";
import {
  PanelTable,
  PanelTableRow,
  panelRowTitleClassName,
  type PanelTableColumn,
} from "../layout/panel";

/** A page or workflow in the workspace: one file, which opens in Backoffice. */
export type ArtifactFile = {
  /** Its source, such as `reports/operations.page.js`. */
  path: string;
  /** What it is called, such as `reports/operations`. */
  name: string;
  to: string;
  filesTo: string;
  /** When its source last changed, as people read it, such as `2h ago`. */
  edited: string;
};

/** What a site serves: nothing until it is built, then its last good build at its address. */
export type ArtifactSiteServing =
  | { kind: "unbuilt" }
  | { kind: "unreadable"; message: string }
  | { kind: "built"; public: boolean; url: string };

/** A site in the workspace, which opens at an address of its own. */
export type ArtifactSite = {
  /** Its folder, such as `tools/shop.site`. */
  path: string;
  /** What it is called, such as `tools/shop`. */
  name: string;
  filesTo: string;
  /** When any of its files last changed, as people read it. */
  edited: string;
  serving: ArtifactSiteServing;
};

const FILE_COLUMNS: readonly PanelTableColumn[] = [
  { label: "Source", align: "start" },
  { label: "Edited", align: "end" },
  { label: "", align: "end" },
];

const SITE_COLUMNS: readonly PanelTableColumn[] = [
  { label: "Address", align: "start" },
  { label: "Visibility", align: "start" },
  { label: "Edited", align: "end" },
  { label: "", align: "end" },
];

/**
 * What agents built in the workspace: pages, which open in Backoffice; sites, which open at their
 * own address; and workflows, whose runs the dashboard shows. `sites` is null where the
 * deployment serves no sites.
 */
export function ArtifactsView({
  pages,
  sites,
  workflows,
}: {
  pages: readonly ArtifactFile[];
  sites: readonly ArtifactSite[] | null;
  workflows: readonly ArtifactFile[];
}) {
  return (
    <div className="space-y-8">
      <FilePanel
        title="Pages"
        icon="layout"
        empty="No pages yet. Ask an agent for one, such as a table of this week's orders."
        files={pages}
      />
      {sites === null ? null : (
        <PanelTable
          title="Sites"
          columns={SITE_COLUMNS}
          empty="No sites yet. Ask an agent to build one, such as a form your customers fill in."
          footer={null}
        >
          {sites.map((site) => (
            <PanelTableRow
              key={site.path}
              title={
                <ArtifactTitle icon="globe">
                  {site.serving.kind === "built" ? (
                    <a
                      href={site.serving.url}
                      target="_blank"
                      rel="noreferrer"
                      className={panelRowTitleClassName}
                      title={site.name}
                    >
                      <ArtifactName name={site.name} />
                    </a>
                  ) : (
                    <span className="block truncate text-sm font-semibold" title={site.name}>
                      <ArtifactName name={site.name} />
                    </span>
                  )}
                </ArtifactTitle>
              }
              columns={SITE_COLUMNS}
              cells={[
                <SiteAddress key="address" serving={site.serving} />,
                <SiteVisibility key="visibility" serving={site.serving} />,
                <EditedTime key="edited" edited={site.edited} />,
                <ShowInFiles key="files" name={site.name} to={site.filesTo} />,
              ]}
            />
          ))}
        </PanelTable>
      )}
      <FilePanel
        title="Workflows"
        icon="share-2"
        empty="No workflows yet. Ask an agent to automate something, such as filing incoming invoices."
        files={workflows}
      />
    </div>
  );
}

function FilePanel({
  title,
  icon,
  empty,
  files,
}: {
  title: string;
  icon: IconName;
  empty: string;
  files: readonly ArtifactFile[];
}) {
  return (
    <PanelTable title={title} columns={FILE_COLUMNS} empty={empty} footer={null}>
      {files.map((file) => (
        <PanelTableRow
          key={file.path}
          title={
            <ArtifactTitle icon={icon}>
              <Link to={file.to} className={panelRowTitleClassName} title={file.name}>
                <ArtifactName name={file.name} />
              </Link>
            </ArtifactTitle>
          }
          columns={FILE_COLUMNS}
          cells={[
            <span key="source" className="font-mono text-xs text-[var(--bo-muted)]">
              {file.path}
            </span>,
            <EditedTime key="edited" edited={file.edited} />,
            <ShowInFiles key="files" name={file.name} to={file.filesTo} />,
          ]}
        />
      ))}
    </PanelTable>
  );
}

function ArtifactTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon name={icon} className="size-4 shrink-0 text-[var(--bo-muted-2)]" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** The folder part of a name recedes, so artifacts read by name. */
function ArtifactName({ name }: { name: string }) {
  const nameStart = name.lastIndexOf("/") + 1;
  return (
    <>
      <span className="font-normal text-[var(--bo-muted-2)]">{name.slice(0, nameStart)}</span>
      <span className="text-[var(--bo-fg)]">{name.slice(nameStart)}</span>
    </>
  );
}

function SiteAddress({ serving }: { serving: ArtifactSiteServing }) {
  if (serving.kind !== "built") {
    return <span className="text-xs text-[var(--bo-muted-2)]">—</span>;
  }
  // The scheme and trailing slash say nothing people need to tell sites apart.
  const address = serving.url.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  return (
    <a
      href={serving.url}
      target="_blank"
      rel="noreferrer"
      title={serving.url}
      className="inline-flex max-w-[40rem] min-w-0 items-center gap-1 font-mono text-xs text-[var(--bo-muted)] hover:text-[var(--bo-fg)] hover:underline"
    >
      <span className="truncate">{address}</span>
      <Icon name="external-link" className="size-3 shrink-0" />
    </a>
  );
}

function SiteVisibility({ serving }: { serving: ArtifactSiteServing }) {
  switch (serving.kind) {
    case "unbuilt":
      return <BackofficeStatusLight tone="waiting">Not built</BackofficeStatusLight>;
    case "unreadable":
      return (
        <span title={serving.message}>
          <BackofficeStatusLight tone="failed">Build unreadable</BackofficeStatusLight>
        </span>
      );
    case "built":
      return serving.public ? (
        <BackofficeStatusLight tone="live">Public</BackofficeStatusLight>
      ) : (
        <BackofficeStatusLight tone="muted">Private</BackofficeStatusLight>
      );
    default:
      throw new Error("Unknown site serving.", { cause: serving satisfies never });
  }
}

function EditedTime({ edited }: { edited: string }) {
  return <span className="text-xs text-[var(--bo-muted-2)] tabular-nums">{edited}</span>;
}

function ShowInFiles({ name, to }: { name: string; to: string }) {
  return (
    <IconButtonLink label={`Show ${name} in Files`} to={to}>
      <Icon name="folder" className="size-4" />
    </IconButtonLink>
  );
}
