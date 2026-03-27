import { getRegisteredFileContributors, registerFileContributor } from "../registry";
import { automationHooksFileContributor } from "./durable-hooks";
import { resendFileContributor } from "./resend";
import { starterFileContributor } from "./starter";
import { staticFileContributor } from "./static";
import { tmpFileContributor } from "./tmp";

const BUILT_IN_FILE_CONTRIBUTORS = [
  staticFileContributor,
  starterFileContributor,
  tmpFileContributor,
  resendFileContributor,
  automationHooksFileContributor,
] as const;

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
