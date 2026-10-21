import { useOutletContext, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/package-selection";
import type { MarketplacePackageOutletContext } from "./detail";
import { loadMarketplacePackageFile } from "./package-file.server";
import { MarketplacePackageFiles } from "./package-files";
import type { MarketplacePackageSelectedContent } from "./package-files-model";

export async function loader(args: Route.LoaderArgs) {
  const selectedPath = args.url.searchParams.get("packagePath")?.trim();
  const selectedTab = args.url.searchParams.get("packageTab");
  const contentRequested = args.url.searchParams.get("packageContent") === "text";
  const selectedFile = selectedTab === "files" && contentRequested;
  const selectedWorkflow =
    selectedTab === "workflows" && selectedPath?.toLowerCase().endsWith(".workflow.js");
  if (!selectedPath || (!selectedFile && !selectedWorkflow)) {
    return { selectedContent: null };
  }

  const response = await loadMarketplacePackageFile(args);
  if (!response.ok) {
    return { selectedContent: null };
  }

  return {
    selectedContent: {
      path: selectedPath,
      text: await response.text(),
    } satisfies MarketplacePackageSelectedContent,
  };
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }

  for (const parameter of ["packageTab", "packagePath", "packageVersion", "packageContent"]) {
    if (currentUrl.searchParams.get(parameter) !== nextUrl.searchParams.get(parameter)) {
      return true;
    }
  }
  return false;
}

export default function MarketplacePackageSelection({ loaderData }: Route.ComponentProps) {
  const { packageFiles } = useOutletContext<MarketplacePackageOutletContext>();
  return (
    <MarketplacePackageFiles data={packageFiles} selectedContent={loaderData.selectedContent} />
  );
}
