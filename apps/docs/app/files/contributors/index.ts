import { getRegisteredFileContributors, registerFileContributor } from "../registry";
import { starterFileContributor } from "./starter";
import { staticFileContributor } from "./static";

const BUILT_IN_FILE_CONTRIBUTORS = [staticFileContributor, starterFileContributor] as const;

export const ensureBuiltInFileContributorsRegistered = (): void => {
  const registeredIds = new Set(
    getRegisteredFileContributors().map((contributor) => contributor.id),
  );

  for (const contributor of BUILT_IN_FILE_CONTRIBUTORS) {
    if (registeredIds.has(contributor.id)) {
      continue;
    }

    registerFileContributor(contributor);
    registeredIds.add(contributor.id);
  }
};
