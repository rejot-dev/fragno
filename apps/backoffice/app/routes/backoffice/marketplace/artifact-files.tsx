import { PackageOpen } from "lucide-react";
import { useLocation } from "react-router";

import { FilesExplorerView } from "@/components/backoffice/files-explorer";

import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";

export function MarketplaceArtifactFiles({ data }: { data: MarketplaceArtifactExplorerData }) {
  const location = useLocation();

  if (data.state !== "ready") {
    return (
      <section className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-6">
        <h3 className="text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          Package contents unavailable
        </h3>
        <p
          className={`mt-2 text-sm leading-6 text-pretty ${data.state === "error" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]"}`}
        >
          {data.message}
        </p>
      </section>
    );
  }

  const publishedVersionCount = data.tree.reduce(
    (count, root) => count + (root.children?.length ?? 0),
    0,
  );

  return (
    <section className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h3 className="text-xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
            Published package contents
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Inspect every immutable release exactly as it was published to the Marketplace.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="inline-flex min-h-7 items-center px-2 font-mono text-[9px] tracking-[0.12em] text-[var(--bo-muted-2)] uppercase shadow-[inset_0_0_0_1px_var(--bo-border)]">
            {publishedVersionCount} {publishedVersionCount === 1 ? "release" : "releases"}
          </span>
          <span className="inline-flex min-h-7 items-center bg-[var(--bo-live-bg)] px-2 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-live)] uppercase shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-live)_35%,transparent)]">
            Read only
          </span>
        </div>
      </div>

      <div className="mt-5">
        <FilesExplorerView
          tree={data.tree}
          selectedPath={data.selectedPath}
          selectedDetail={data.selectedDetail}
          loadError={data.loadError}
          treeLabel="Package index"
          treeAriaLabel="Marketplace artifact files"
          rootIcon={PackageOpen}
          rootSelection="detail"
          detailHeadingLevel={4}
          emptySelection={
            <div className="flex min-h-64 items-center justify-center p-6 text-center">
              <p className="max-w-xs text-sm text-pretty text-[var(--bo-muted)]">
                Select a release, folder, or file to inspect its published details.
              </p>
            </div>
          }
          buildNodeTo={(path) => {
            const search = new URLSearchParams(location.search);
            search.set("artifactPath", path);
            return { pathname: location.pathname, search: `?${search}` };
          }}
        />
      </div>
    </section>
  );
}
