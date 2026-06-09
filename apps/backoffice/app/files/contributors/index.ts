import { automationHooksFileContributor } from "./durable-hooks";
import { resendFileContributor } from "./resend";
import { staticFileContributor } from "./static";
import { staticStarterFileContributor } from "./static-starter";
import { tmpFileContributor } from "./tmp";
import {
  uploadFileContributor,
  uploadR2BindingFileContributor,
  uploadR2RemoteFileContributor,
} from "./upload";

const BUILT_IN_FILE_CONTRIBUTORS = [
  staticFileContributor,
  staticStarterFileContributor,
  uploadFileContributor,
  uploadR2BindingFileContributor,
  uploadR2RemoteFileContributor,
  tmpFileContributor,
  resendFileContributor,
  automationHooksFileContributor,
] as const;

export const getBuiltInFileContributors = () => [...BUILT_IN_FILE_CONTRIBUTORS];
