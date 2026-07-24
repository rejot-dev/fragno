import { runtimeToolFamilies } from "./tool-families";
import { createRuntimeToolWorkflowCatalog } from "./workflow-catalog";

// Source inspection explains known calls independently of whether a tool is currently executable.
export const runtimeToolWorkflowCatalog = createRuntimeToolWorkflowCatalog(runtimeToolFamilies);
