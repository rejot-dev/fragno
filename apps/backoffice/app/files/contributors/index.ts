import { automationHooksFileContributor } from "./durable-hooks";
import { projectWorkspacesFileContributor } from "./project-workspaces";
import { resendFileContributor } from "./resend";
import { staticFileContributor, systemFileContributor } from "./static";
import { tmpFileContributor } from "./tmp";
import {
  uploadFileContributor,
  uploadR2BindingFileContributor,
  uploadR2RemoteFileContributor,
} from "./upload";

const BUILT_IN_FILE_CONTRIBUTORS = [
  staticFileContributor,
  systemFileContributor,
  uploadFileContributor,
  uploadR2BindingFileContributor,
  uploadR2RemoteFileContributor,
  projectWorkspacesFileContributor,
  tmpFileContributor,
  resendFileContributor,
  automationHooksFileContributor,
] as const;

export const getBuiltInFileContributors = () => [...BUILT_IN_FILE_CONTRIBUTORS];
