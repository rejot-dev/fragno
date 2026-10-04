import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { provisionGraftObject } from "@fragno-private/backoffice-node-runtime/graft-object-provisioning";

const configPath = process.argv[2];
const controlRemoteLogId = process.argv[3];
const objectId = process.argv[4];
const barrierDirectory = process.argv[5];
const contenderName = process.argv[6];
if (!configPath || !controlRemoteLogId || !objectId || !barrierDirectory || !contenderName) {
  throw new Error("GRAFT_OBJECT_PROVISIONING_PROCESS_ARGUMENTS_MISSING");
}

const storage = { configPath, controlRemoteLogId };
const controlStore = new GraftControlStore(storage);
try {
  const result = provisionGraftObject({
    objectId,
    storage,
    controlStore,
    clock: { kind: "system" },
    databaseOperations: createBarrierObjectProvisioningOperations(barrierDirectory, contenderName),
  });
  process.stdout.write(`GRAFT_OBJECT_PROVISIONING_RESULT:${JSON.stringify(result)}\n`);
} finally {
  controlStore.close();
}

function createBarrierObjectProvisioningOperations(
  barrierDirectory: string,
  contenderName: string,
): GraftDatabaseOperations {
  const operations = createSqlitePragmaGraftDatabaseOperations();
  let candidatePushed = false;
  return {
    ...operations,
    push(database) {
      operations.push(database);
      if (candidatePushed) {
        return;
      }
      candidatePushed = true;
      writeFileSync(path.join(barrierDirectory, `${contenderName}.ready`), "ready\n");
      const releasePath = path.join(barrierDirectory, "release");
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      while (!existsSync(releasePath)) {
        Atomics.wait(sleeper, 0, 0, 10);
      }
    },
  };
}
