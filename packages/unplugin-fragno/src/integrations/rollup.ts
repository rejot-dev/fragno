import { createRollupPlugin } from "unplugin";
import { unpluginFactory } from "..";

console.log("rollup");
export default createRollupPlugin(unpluginFactory);
