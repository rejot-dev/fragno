import { readAgentPackages } from "./agent-package-releases";

/** Where `marketplace/` is, relative to this module, as `import.meta.glob` names its files. */
const MARKETPLACE = "../../marketplace/";

/**
 * Bookkeeping's agent packages, from `marketplace/`, which the build bundles. Scenarios ship other
 * versions by replacing them.
 */
export const AGENT_PACKAGES = readAgentPackages(
  Object.fromEntries(
    Object.entries(
      // No type argument: Vitest caches a module's transform on disk unless its source contains
      // `import.meta.glob(`, and a cached one would miss files added since.
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- see above
      import.meta.glob("../../marketplace/**/*", {
        eager: true,
        // Declarations live under .marketplace, which only an exhaustive glob finds.
        exhaustive: true,
        query: "?raw",
        import: "default",
      }) as Record<string, string>,
    ).map(([path, content]) => [path.slice(MARKETPLACE.length), content]),
  ),
);

/** Bookkeeping asks this agent, in the books package, for the company details of a customer or supplier. */
export const COMPANY_DETAILS_AGENT_NAME = "company-details";
