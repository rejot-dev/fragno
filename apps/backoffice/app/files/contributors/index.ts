import { automationHooksFileContributor } from "./durable-hooks";
import { resendFileContributor } from "./resend";
import { staticFileContributor } from "./static";
import { staticStarterFileContributor } from "./static-starter";
import { tmpFileContributor } from "./tmp";
import { uploadFileContributor } from "./upload";

export const BUILT_IN_FILE_CONTRIBUTORS = [
  staticFileContributor,
  staticStarterFileContributor,
  uploadFileContributor,
  tmpFileContributor,
  resendFileContributor,
  automationHooksFileContributor,
] as const;

export const getBuiltInFileContributors = () => [...BUILT_IN_FILE_CONTRIBUTORS];
