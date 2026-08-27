import { createCodemodeStaticTypeFiles } from "@/fragno/codemode/codemode-type-files";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

/** Generates the deployment-static codemode declarations consumed by the build script. */
export function generateBackofficeCodemodeStaticTypeFiles() {
  return createCodemodeStaticTypeFiles({ families: runtimeToolFamilies });
}
