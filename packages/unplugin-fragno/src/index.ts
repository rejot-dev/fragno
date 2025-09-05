import type { UnpluginFactory } from "unplugin";
import type { Options } from "./types";
import { createUnplugin } from "unplugin";
import { transform } from "./transform";

export const unpluginFactory: UnpluginFactory<Options | undefined> = (options = {}) => {
  const { platform } = options;

  if (platform !== "browser") {
    return [];
  }

  return {
    name: "unplugin-fragno",
    transformInclude(id) {
      if (id.endsWith(".d.ts")) {
        return false;
      }

      if (id.includes("@fragno-dev/unplugin-fragno") || id.includes("@fragno-dev/core")) {
        return false;
      }

      return true;
    },
    transform(code, id) {
      return transform(code, id, { ssr: false });
    },
  };
};

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory);

export default unplugin;
export type { Options };
export { isMacroBinding } from "./transform-macros";
