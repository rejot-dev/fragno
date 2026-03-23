import { Download, File as FileIcon, Folder, HardDrive, RefreshCcw } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useLoaderData, useOutletContext, useRevalidator } from "react-router";

import { formatBytes } from "@/components/backoffice";
import type { FilesExplorerTreeNode } from "@/files";

import type { Route } from "./+types/explorer";
import { resolveFilesContentRenderer } from "./content-renderers";
import { handleFilesExplorerAction, loadFilesExplorerData } from "./data";
import type { FilesLayoutContext } from "./shared";
import { formatFileRootKind, formatFileRootMutability, formatFileRootPersistence } from "./shared";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return loadFilesExplorerData({ request, context, orgId: params.orgId });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return handleFilesExplorerAction({ request, context, orgId: params.orgId });
}

export function meta({ data }: Route.MetaArgs) {
  const selectedTitle = data?.selectedDetail?.node.title;
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

export default function BackofficeFilesExplorer() {
  const { tree, selectedPath, selectedDetail, loadError } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<FilesLayoutContext>();
  const revalidator = useRevalidator();

  const stats = useMemo(
    () => ({
      total: tree.length,
      writable: tree.filter((root) => !root.readOnly).length,
      persistent: tree.filter((root) => root.persistence === "persistent").length,
    }),
    [tree],
  );
  const selectedContentRenderer = selectedDetail
    ? resolveFilesContentRenderer(selectedDetail)
    : null;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <StatCard label="Registered roots" value={String(stats.total)} />
        <StatCard label="Writable roots" value={String(stats.writable)} />
        <StatCard label="Persistent roots" value={String(stats.persistent)} />
      </section>

      {loadError ? <MessageTone tone="error">{loadError}</MessageTone> : null}

      {tree.length === 0 ? (
        <section className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No filesystem mounts are available for this organisation yet.
        </section>
      ) : (
        <section className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                  File tree
                </p>
                <p className="mt-2 text-sm text-[var(--bo-muted)]">
                  Browse the combined filesystem directly. Select any node to inspect it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => revalidator.revalidate()}
                className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>

            <nav aria-label="Files explorer" className="mt-3 space-y-0.5">
              {tree.map((node) => (
                <TreeNodeRow
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  orgId={orgId}
                  depth={0}
                />
              ))}
            </nav>
          </aside>

          <div className="space-y-4">
            {selectedDetail ? (
              <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      Selection
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">
                      {selectedDetail.node.title}
                    </h2>
                    <p className="mt-2 text-sm text-[var(--bo-muted)]">
                      {selectedDetail.description ?? "Filesystem metadata for the selected node."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedDetail.node.kind === "file" ? (
                      <a
                        href={buildDownloadHref(orgId, selectedDetail.node.path)}
                        className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    ) : null}
                    <Link
                      to={{ search: buildExplorerSearch(selectedDetail.node.mountPoint) }}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Jump to root
                    </Link>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <InlineMetaPill
                    label="Mount"
                    value={formatFileRootKind(selectedDetail.node.mountKind)}
                  />
                  <InlineMetaPill
                    label="Access"
                    value={formatFileRootMutability(selectedDetail.node.readOnly)}
                  />
                  <InlineMetaPill
                    label="Persistence"
                    value={formatFileRootPersistence(selectedDetail.node.persistence)}
                  />
                </div>

                {selectedContentRenderer ? (
                  <div className="mt-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {selectedContentRenderer.label}
                      </p>
                      {selectedDetail.node.contentType ? (
                        <p className="text-[10px] text-[var(--bo-muted-2)]">
                          {selectedDetail.node.contentType}
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-3">{selectedContentRenderer.render(selectedDetail)}</div>
                  </div>
                ) : null}

                <dl className="mt-4 grid gap-x-4 gap-y-2 border-t border-[color:var(--bo-border)] pt-3 md:grid-cols-2 xl:grid-cols-3">
                  {selectedDetail.fields.map((field) => (
                    <div key={`${field.label}-${field.value}`} className="min-w-0">
                      <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        {field.label}
                      </dt>
                      <dd className="mt-1 text-xs break-all text-[var(--bo-muted)]">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {selectedDetail.metadata && Object.keys(selectedDetail.metadata).length > 0 ? (
                  <div className="mt-4 border-t border-[color:var(--bo-border)] pt-3">
                    <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      Metadata
                    </p>
                    <pre className="mt-2 max-h-72 overflow-auto text-[11px] text-[var(--bo-muted)]">
                      {JSON.stringify(selectedDetail.metadata, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

function TreeNodeRow({
  node,
  selectedPath,
  orgId,
  depth,
}: {
  node: FilesExplorerTreeNode;
  selectedPath: string | null;
  orgId: string;
  depth: number;
}) {
  const isSelected = selectedPath === node.path;
  const Icon = node.kind === "root" ? HardDrive : node.kind === "folder" ? Folder : FileIcon;

  return (
    <div>
      <Link
        to={{ pathname: `/backoffice/files/${orgId}`, search: buildExplorerSearch(node.path) }}
        aria-current={isSelected ? "page" : undefined}
        className={
          isSelected
            ? "flex items-center gap-1.5 rounded-sm border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-1.5 py-1 text-[13px] text-[var(--bo-fg)]"
            : "flex items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-1 text-[13px] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]"
        }
        style={{ paddingLeft: `${0.25 + depth * 0.75}rem` }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{node.title}</span>
        {typeof node.sizeBytes === "number" && node.kind === "file" ? (
          <span className="ml-auto text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {formatBytes(node.sizeBytes)}
          </span>
        ) : null}
      </Link>

      {node.children?.length ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              orgId={orgId}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InlineMetaPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1">
      <span className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </span>
      <span className="ml-2 text-xs text-[var(--bo-muted)]">{value}</span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">{value}</p>
    </div>
  );
}

function MessageTone({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-[color:var(--bo-border-strong)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
      : "border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-fg)]";

  return <section className={`border p-3 text-sm ${toneClass}`}>{children}</section>;
}

function buildExplorerSearch(path: string) {
  const params = new URLSearchParams();
  params.set("path", path);
  return `?${params.toString()}`;
}

function buildDownloadHref(orgId: string, path: string) {
  const params = new URLSearchParams();
  params.set("path", path);
  return `/backoffice/files/${orgId}/download?${params.toString()}`;
}
