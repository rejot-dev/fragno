import { defineConfig } from "tsdown";
export default defineConfig({
  fixedExtension: false,
  entry: ["./src/backoffice-local.ts", "./src/backoffice-dev-server-port.ts"],
  dts: true,
});
