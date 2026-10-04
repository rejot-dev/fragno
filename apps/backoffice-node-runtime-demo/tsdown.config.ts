import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/start-fleet.ts",
    "./src/start-node.ts",
    "./src/start-gateway.ts",
    "./src/gateway/gateway.scenario.ts",
    "./src/testing/native-graft-extension-smoke.ts",
    "./src/testing/fixtures/provision-filesystem-graft-storage-process.ts",
    "./src/objects/demo-object.ts",
    "./src/node/node.scenario.ts",
    "./src/fleet/fleet.scenario.ts",
  ],
  platform: "node",
  target: "node26",
  dts: false,
  unbundle: true,
});
