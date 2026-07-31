import { Download, File as FileIcon, Folder, HardDrive, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Link, type To } from "react-router";

import type { FilesExplorerTreeNode, FilesNodeDetail } from "@/files";

import { BackofficeSystemState } from "../system-state";
import { resolveFilesContentRenderer } from "./content-renderers";

export type FilesExplorerViewProps = {
  tree: readonly FilesExplorerTreeNode[];
  selectedPath: string | null;
  selectedDetail: FilesNodeDetail | null;
  loadError: string | null;
  buildNodeTo: (path: string) => To;
  buildDownloadHref?: (path: string) => string | null;
  treeLabel?: string;
  treeAriaLabel?: string;
  rootIcon?: LucideIcon;
  rootSelection?: "summary" | "detail";
  detailHeadingLevel?: 2 | 3 | 4;
  emptySelection?: ReactNode;
};

export function FilesExplorerView({
  tree,
  selectedPath,
  selectedDetail,
  loadError,
  buildNodeTo,
  buildDownloadHref,
  treeLabel = "File tree",
  treeAriaLabel = "Files explorer",
  rootIcon = HardDrive,
  rootSelection = "summary",
  detailHeadingLevel = 2,
  emptySelection = null,
}: FilesExplorerViewProps) {
  const selectedRoot =
    rootSelection === "summary" && selectedDetail?.node.kind === "root" ? selectedDetail : null;

  return (
    <div className="space-y-4">
      {loadError ? <MessageTone tone="error">{loadError}</MessageTone> : null}

      {tree.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="No mounted roots"
          title="This workspace has no filesystems yet."
          description="Configure a filesystem contributor or upload integration to make files available here."
        />
      ) : (
        <section className="grid min-h-[22rem] gap-px overflow-hidden bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="bg-[var(--bo-panel-2)] p-3">
            <div className="flex min-h-8 items-center justify-between gap-3 px-1">
              <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                {treeLabel}
              </p>
              <span className="font-mono text-[9px] text-[var(--bo-muted-2)]">
                {tree.length} {tree.length === 1 ? "root" : "roots"}
              </span>
            </div>

            <nav aria-label={treeAriaLabel} className="mt-2 space-y-0.5">
              {tree.map((node) => (
                <FilesTreeNodeRow
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  buildNodeTo={buildNodeTo}
                  rootIcon={rootIcon}
                  depth={0}
                />
              ))}
            </nav>
          </aside>

          <div className="min-w-0 bg-[var(--bo-panel)]">
            {selectedRoot ? (
              <RootSelectionState
                detail={selectedRoot}
                icon={rootIcon}
                headingLevel={detailHeadingLevel}
              />
            ) : selectedDetail ? (
              <FilesNodeDetailPanel
                detail={selectedDetail}
                buildDownloadHref={buildDownloadHref}
                rootIcon={rootIcon}
                headingLevel={detailHeadingLevel}
              />
            ) : (
              emptySelection
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function FilesNodeDetailPanel({
  detail,
  buildDownloadHref,
  rootIcon: RootIcon,
  headingLevel,
}: {
  detail: FilesNodeDetail;
  buildDownloadHref?: (path: string) => string | null;
  rootIcon: LucideIcon;
  headingLevel: 2 | 3 | 4;
}) {
  const contentRenderer = resolveFilesContentRenderer(detail);
  const downloadHref =
    detail.node.kind === "file" ? (buildDownloadHref?.(detail.node.path) ?? null) : null;
  const Heading = getHeadingComponent(headingLevel);
  const DetailIcon =
    detail.node.kind === "root" ? RootIcon : detail.node.kind === "folder" ? Folder : FileIcon;

  return (
    <section className="min-h-full p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            <DetailIcon className="size-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {detail.node.kind}
            </p>
            <Heading className="mt-1 text-2xl font-semibold tracking-tight text-balance break-all text-[var(--bo-fg)]">
              {detail.node.title}
            </Heading>
          </div>
        </div>
        {downloadHref ? (
          <a
            href={downloadHref}
            className="bo-control-surface inline-flex min-h-10 items-center gap-2 bg-[var(--bo-panel-2)] px-3.5 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </a>
        ) : null}
      </div>

      {contentRenderer ? (
        <div className="mt-5 bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)] md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {contentRenderer.label}
            </p>
            {detail.node.contentType ? (
              <p className="font-mono text-[9px] text-[var(--bo-muted-2)]">
                {detail.node.contentType}
              </p>
            ) : null}
          </div>
          <div className="mt-3">{contentRenderer.render(detail)}</div>
        </div>
      ) : null}

      <dl className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {detail.fields.map((field) => (
          <div
            key={`${field.label}-${field.value}`}
            className="min-w-0 bg-[var(--bo-panel-2)] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--bo-border)]"
          >
            <dt className="font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
              {field.label}
            </dt>
            <dd className="mt-1.5 text-xs break-all text-[var(--bo-muted)]">{field.value}</dd>
          </div>
        ))}
      </dl>

      {detail.metadata && Object.keys(detail.metadata).length > 0 ? (
        <div className="mt-5">
          <p className="font-mono text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Metadata
          </p>
          <pre className="backoffice-scroll mt-3 max-h-72 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-5 text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            {JSON.stringify(detail.metadata, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function RootSelectionState({
  detail,
  icon: Icon,
  headingLevel,
}: {
  detail: FilesNodeDetail;
  icon: LucideIcon;
  headingLevel: 2 | 3 | 4;
}) {
  const isEmpty = (detail.node.fileCount ?? 0) + (detail.node.folderCount ?? 0) === 0;
  const Heading = getHeadingComponent(headingLevel);

  return (
    <section className="flex min-h-full items-center justify-center bg-[var(--bo-panel)] p-6">
      <div className="max-w-sm text-center">
        <div className="bo-control-surface mx-auto flex size-12 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)]">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <p className="mt-4 font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          Mount selected
        </p>
        <Heading className="mt-2 text-xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          {detail.node.title}
        </Heading>
        <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">
          {isEmpty
            ? "This mount is empty. Files and folders will appear here when they become available."
            : "Choose a file or folder in the sidebar to inspect its contents."}
        </p>
      </div>
    </section>
  );
}

function FilesTreeNodeRow({
  node,
  selectedPath,
  buildNodeTo,
  rootIcon: RootIcon,
  depth,
}: {
  node: FilesExplorerTreeNode;
  selectedPath: string | null;
  buildNodeTo: (path: string) => To;
  rootIcon: LucideIcon;
  depth: number;
}) {
  const isSelected = selectedPath === node.path;
  const Icon = node.kind === "root" ? RootIcon : node.kind === "folder" ? Folder : FileIcon;

  return (
    <div>
      <Link
        to={buildNodeTo(node.path)}
        preventScrollReset
        aria-current={isSelected ? "page" : undefined}
        className={
          isSelected
            ? "flex min-h-10 items-center gap-2 bg-[var(--bo-accent-bg)] px-2 py-1 text-[13px] font-medium text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-accent)] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
            : "flex min-h-10 items-center gap-2 px-2 py-1 text-[13px] text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_transparent] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] hover:shadow-[inset_0_0_0_1px_var(--bo-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
        }
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${isSelected ? "text-[var(--bo-accent)]" : "text-[var(--bo-muted-2)]"}`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{node.title}</span>
      </Link>

      {node.children?.length ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FilesTreeNodeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              buildNodeTo={buildNodeTo}
              rootIcon={RootIcon}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageTone({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"
      : "border-[color:var(--bo-live)] bg-[var(--bo-live-bg)] text-[var(--bo-live)]";

  return <section className={`border p-3 text-sm ${toneClass}`}>{children}</section>;
}

function getHeadingComponent(level: 2 | 3 | 4): "h2" | "h3" | "h4" {
  if (level === 3) {
    return "h3";
  }
  if (level === 4) {
    return "h4";
  }
  return "h2";
}
