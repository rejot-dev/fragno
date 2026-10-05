import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionFilesystemGraftStorage } from "../fleet/local-filesystem-graft-storage";

const directory = await mkdtemp(path.join(os.tmpdir(), "demo-native-smoke-"));
try {
  // Provisioning pushes a schema and verifies it through a new remote clone before returning.
  const result = await provisionFilesystemGraftStorage(directory);
  console.log(
    `DEMO_NATIVE_GRAFT_LOADED:${JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      extensionPath: process.env["FRAGNO_GRAFT_EXTENSION_PATH"] ?? "sqlite-graft",
      controlRemoteLogId: result.controlRemoteLogId,
    })}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
