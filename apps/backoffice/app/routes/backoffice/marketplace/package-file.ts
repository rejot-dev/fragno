import type { Route } from "./+types/package-file";
import { loadMarketplacePackageFile } from "./package-file.server";

export function loader(args: Route.LoaderArgs) {
  return loadMarketplacePackageFile(args);
}
