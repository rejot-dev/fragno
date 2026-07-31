import type { Route } from "./+types/artifact-file";
import { loadMarketplaceArtifactFile } from "./artifact-file.server";

export function loader(args: Route.LoaderArgs) {
  return loadMarketplaceArtifactFile(args);
}
