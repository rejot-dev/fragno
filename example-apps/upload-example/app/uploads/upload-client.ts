import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export type UploadClient = ReturnType<typeof createUploadFragmentClient>;

export const directUploadClient = createUploadFragmentClient({
  mountRoute: "/api/uploads-direct",
});

export const proxyUploadClient = createUploadFragmentClient({
  mountRoute: "/api/uploads-proxy",
});
