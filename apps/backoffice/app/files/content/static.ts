import systemGuidanceTemplate from "../../../content/static/SYSTEM.md?raw";
import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import type { FileCollection } from "../../file-collection/file-collection";
import { STATIC_DOC_CONTENT } from "./docs";
import { GENERAL_SKILL_CONTENT } from "./skills";
import { STATIC_AUTOMATION_CONTENT } from "./static-automations";

export const renderStaticGuidance = ({ codemodeDts }: { codemodeDts: string }) =>
  systemGuidanceTemplate.replace("__BACKOFFICE_CODEMODE_DTS__", codemodeDts.trimEnd());

export const STATIC_FILE_CONTENT = {
  "SYSTEM.md": systemGuidanceTemplate,
  ...STATIC_DOC_CONTENT,
  ...STATIC_AUTOMATION_CONTENT,
  ...GENERAL_SKILL_CONTENT,
} satisfies Record<string, string | Uint8Array>;

export type StaticFileArtifactsLoader = () =>
  | Promise<Record<string, string | Uint8Array>>
  | Record<string, string | Uint8Array>;

export function createBackofficeStaticFileCollection(
  loadStaticFileArtifacts: StaticFileArtifactsLoader,
): FileCollection {
  let collectionPromise: Promise<FileCollection> | undefined;

  const getCollection = () =>
    (collectionPromise ??= Promise.resolve(loadStaticFileArtifacts()).then((loadedArtifacts) =>
      createStaticFileCollection({
        ...STATIC_FILE_CONTENT,
        ...loadedArtifacts,
      }),
    ));

  return {
    async getTree() {
      return (await getCollection()).getTree();
    },
    async getFile(path) {
      return (await getCollection()).getFile(path);
    },
    async searchFiles(pattern, query, options, cursor) {
      return (await getCollection()).searchFiles(pattern, query, options, cursor);
    },
  };
}
