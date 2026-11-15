import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Builds ignore .env (vite.config.ts) so that Turbo can share them between machines. A deploy loads
// it into the environment instead, where Turbo hashes the VITE_* settings it declares, so the build
// it ships embeds them and no cached build without them can stand in.
const envFilePath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const turboExecutable = process.platform === "win32" ? "turbo.cmd" : "turbo";
const result = spawnSync(turboExecutable, ["run", "build", "--filter=@fragno-apps/backoffice-rr"], {
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
