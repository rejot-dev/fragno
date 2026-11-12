import type { ReactNode } from "react";

import { ArtifactsView, type ArtifactFile, type ArtifactSite } from "./artifacts-view";

export default { title: "Artifacts/Artifacts" };

const PAGES: readonly ArtifactFile[] = [
  {
    path: "orders.page.js",
    name: "orders",
    to: "#",
    filesTo: "#",
    edited: "12m ago",
  },
  {
    path: "reports/operations.page.js",
    name: "reports/operations",
    to: "#",
    filesTo: "#",
    edited: "2h ago",
  },
  {
    path: "reports/finance/cash-flow.page.js",
    name: "reports/finance/cash-flow",
    to: "#",
    filesTo: "#",
    edited: "3d ago",
  },
];

const SITES: readonly ArtifactSite[] = [
  {
    path: "intake-form.site",
    name: "intake-form",
    filesTo: "#",
    edited: "5m ago",
    serving: {
      kind: "built",
      public: true,
      url: "https://quiet-amber-falcon-public.ley.run/intake-form.site/",
    },
  },
  {
    path: "submissions.site",
    name: "submissions",
    filesTo: "#",
    edited: "1h ago",
    serving: {
      kind: "built",
      public: false,
      url: "https://quiet-amber-falcon.ley.run/submissions.site/",
    },
  },
  {
    path: "tools/shop.site",
    name: "tools/shop",
    filesTo: "#",
    edited: "now",
    serving: { kind: "unbuilt" },
  },
  {
    path: "tools/legacy.site",
    name: "tools/legacy",
    filesTo: "#",
    edited: "2w ago",
    serving: {
      kind: "unreadable",
      message: "/workspace/.build/tools/legacy.site/build.json is not JSON.",
    },
  },
];

const WORKFLOWS: readonly ArtifactFile[] = [
  {
    path: "automations/file-invoices.workflow.js",
    name: "automations/file-invoices",
    to: "#",
    filesTo: "#",
    edited: "40m ago",
  },
  {
    path: "automations/weekly-summary.workflow.js",
    name: "automations/weekly-summary",
    to: "#",
    filesTo: "#",
    edited: "5d ago",
  },
];

function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[96rem]">{children}</div>;
}

export function Overview() {
  return (
    <Page>
      <ArtifactsView pages={PAGES} sites={SITES} workflows={WORKFLOWS} />
    </Page>
  );
}

export function Empty() {
  return (
    <Page>
      <ArtifactsView pages={[]} sites={[]} workflows={[]} />
    </Page>
  );
}

/** Deployments without a sites domain serve no sites, so only pages and workflows are listed. */
export function WithoutSites() {
  return (
    <Page>
      <ArtifactsView pages={PAGES} sites={null} workflows={WORKFLOWS} />
    </Page>
  );
}
