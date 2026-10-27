import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export type UploadClient = ReturnType<typeof createUploadFragmentClient>;

export const uploadClient = createUploadFragmentClient({ mountRoute: "/api/uploads" });
