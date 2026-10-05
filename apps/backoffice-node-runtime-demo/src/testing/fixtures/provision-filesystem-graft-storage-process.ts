import { provisionFilesystemGraftStorage } from "../../fleet/local-filesystem-graft-storage";

const dataDirectory = process.argv[2];
if (!dataDirectory) {
  throw new Error("DEMO_FILESYSTEM_STORAGE_PROCESS_DATA_DIRECTORY_REQUIRED");
}
const result = await provisionFilesystemGraftStorage(dataDirectory);
console.log(`DEMO_FILESYSTEM_STORAGE_PROVISIONED:${JSON.stringify(result)}`);
