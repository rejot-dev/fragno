import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-control-database";

// Exercise native loading, remote publication, and fresh-clone verification in the final image.
const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-native-smoke-"));
try {
  const cache = path.join(directory, "cache");
  const remote = path.join(directory, "remote");
  const configPath = path.join(directory, "graft.toml");
  await Promise.all([mkdir(cache), mkdir(remote)]);
  await writeFile(
    configPath,
    [
      `data_dir = ${JSON.stringify(cache)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(remote)}`,
      "",
    ].join("\n"),
  );
  const controlRemoteLogId = provisionGraftControlDatabase(configPath);
  console.info("BACKOFFICE_NATIVE_GRAFT_LOADED", {
    platform: process.platform,
    arch: process.arch,
    controlRemoteLogId,
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
