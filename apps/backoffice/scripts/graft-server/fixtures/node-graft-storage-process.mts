import { open } from "node:fs/promises";
import path from "node:path";

import {
  reserveGraftControlDatabase,
  verifyGraftControlDatabase,
} from "@fragno-private/backoffice-node-runtime/graft-control-database";

const { resolveNodeBackofficeGraftStorage } = (await import(
  new URL("../node-graft-storage.ts", import.meta.url).href
)) as typeof import("../node-graft-storage");

if (process.argv[2] === "reserve") {
  const configPath = path.resolve(".backoffice-graft/graft.toml");
  const controlRemoteLogId = reserveGraftControlDatabase(configPath);
  const file = await open(path.resolve(".backoffice-graft/control-log-id"), "wx");
  try {
    await file.writeFile(`${controlRemoteLogId}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  // End before publication to leave the same persisted reservation as an interrupted first run.
  console.info(JSON.stringify({ configPath, controlRemoteLogId }));
} else {
  const storage = await resolveNodeBackofficeGraftStorage(process.env);
  verifyGraftControlDatabase(storage.configPath, storage.controlRemoteLogId);
  console.info(JSON.stringify(storage));
}
