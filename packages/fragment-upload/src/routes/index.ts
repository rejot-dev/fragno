import { fileRoutesFactory } from "./files";
import { uploadRoutesFactory } from "./uploads";

export const uploadRoutes = [uploadRoutesFactory, fileRoutesFactory] as const;

export { fileRoutesFactory, uploadRoutesFactory };
