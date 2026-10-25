import { renderStaticGuidance } from "@/files/content/static";
import {
  CODEMODE_SYSTEM_DTS_PATH,
  createCodemodeTypeFiles as createCodemodeTypeFilesFromTemplates,
  renderCodemodeStateExcerpt,
} from "@/fragno/codemode/codemode-type-files";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";

import pageTypes from "../../../content/static/codemode/page.d.ts?raw";
import uiTypes from "../../../content/static/codemode/ui.d.ts?raw";
import workflowAuthoringTypes from "../../../content/static/codemode/workflow-authoring.d.ts?raw";

export const renderCodemodeSystemPrompt = async ({
  state,
}: {
  state: { readFile(path: string): Promise<string> };
}) =>
  renderStaticGuidance({
    codemodeDts: await state.readFile(CODEMODE_SYSTEM_DTS_PATH),
    stateExcerpt: renderCodemodeStateExcerpt(),
  });

/** Generates codemode declarations from the application templates for tests and transient use. */
export function createCodemodeTypeFiles({
  families,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
}) {
  return createCodemodeTypeFilesFromTemplates({
    families,
    authoredTypes: { workflowAuthoring: workflowAuthoringTypes, ui: uiTypes, page: pageTypes },
  });
}
