import type { UnpluginInstance } from "unplugin";
import { createFarmPlugin } from "unplugin";

import { unpluginFactory } from "..";
import type { Options } from "../types";

const farmPlugin: UnpluginInstance<Options | undefined>["farm"] = createFarmPlugin(unpluginFactory);

export default farmPlugin;
