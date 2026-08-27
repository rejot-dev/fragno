import { renderStaticGuidance } from "@/files/content/static";
import {
  CODEMODE_SYSTEM_DTS_PATH,
  createCodemodeTypeFiles as createCodemodeTypeFilesFromTemplates,
} from "@/fragno/codemode/codemode-type-files";
import type { McpCodemodeServer } from "@/fragno/codemode/mcp-codemode-tools";
import type { BackofficeRuntimeToolFamily } from "@/fragno/runtime-tools/runtime-tools";

import workflowAuthoringTypes from "../../../content/static/codemode/workflow-authoring.d.ts?raw";

export const renderCodemodeSystemPrompt = async ({
  state,
}: {
  state: { readFile(path: string): Promise<string> };
}) =>
  renderStaticGuidance({
    codemodeDts: await state.readFile(CODEMODE_SYSTEM_DTS_PATH),
  });

/** Generates codemode declarations from the application templates for tests and transient use. */
export function createCodemodeTypeFiles({
  families,
  mcpServers = [],
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  mcpServers?: readonly McpCodemodeServer[];
}) {
  return createCodemodeTypeFilesFromTemplates({
    families,
    mcpServers,
    workflowAuthoringTypes,
  });
}
