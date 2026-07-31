import { useOutletContext, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/artifact-selection";
import { loadMarketplaceArtifactFile } from "./artifact-file.server";
import { MarketplaceArtifactFiles } from "./artifact-files";
import type { MarketplaceArtifactSelectedContent } from "./artifact-files-model";
import type { MarketplaceArtifactOutletContext } from "./detail";

export async function loader(args: Route.LoaderArgs) {
  const selectedPath = args.url.searchParams.get("artifactPath")?.trim();
  const selectedTab = args.url.searchParams.get("artifactTab");
  const contentRequested = args.url.searchParams.get("artifactContent") === "text";
  const selectedFile = selectedTab === "files" && contentRequested;
  const selectedWorkflow =
    selectedTab === "workflows" && selectedPath?.toLowerCase().endsWith(".workflow.js");
  if (!selectedPath || (!selectedFile && !selectedWorkflow)) {
    return { selectedContent: null };
  }

  const response = await loadMarketplaceArtifactFile(args);
  if (!response.ok) {
    return { selectedContent: null };
  }

  return {
    selectedContent: {
      path: selectedPath,
      text: await response.text(),
    } satisfies MarketplaceArtifactSelectedContent,
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

  for (const parameter of ["artifactTab", "artifactPath", "artifactVersion", "artifactContent"]) {
    if (currentUrl.searchParams.get(parameter) !== nextUrl.searchParams.get(parameter)) {
      return true;
    }
  }
  return false;
}

export default function MarketplaceArtifactSelection({ loaderData }: Route.ComponentProps) {
  const { artifactFiles } = useOutletContext<MarketplaceArtifactOutletContext>();
  return (
    <MarketplaceArtifactFiles data={artifactFiles} selectedContent={loaderData.selectedContent} />
  );
}
