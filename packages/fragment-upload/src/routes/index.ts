import { fileLinkRoutesFactory } from "./file-links";
import { fileRoutesFactory } from "./files";
import { uploadRoutesFactory } from "./uploads";

export const uploadRoutes = [
  uploadRoutesFactory,
  fileRoutesFactory,
  fileLinkRoutesFactory,
] as const;

export { fileRoutesFactory, uploadRoutesFactory };
