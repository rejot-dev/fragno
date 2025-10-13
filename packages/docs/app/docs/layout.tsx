import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { FragnoCircle } from "@/components/logos/fragno-circle";

import { defaultMetadata } from "@/lib/metadata";

export const metadata = {
  ...defaultMetadata,
  title: {
    template: "%s | Fragno Docs",
    default: "Fragno",
  },
};

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.pageTree}
      {...baseOptions()}
      nav={{
        title: (
          <div className="flex items-center gap-1">
            <FragnoCircle className="size-12 dark:text-white" />
            <span className="text-lg font-semibold tracking-tight">Fragno</span>
          </div>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
