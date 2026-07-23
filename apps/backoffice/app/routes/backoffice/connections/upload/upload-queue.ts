export const shouldAutoStartUploads = (input: {
  uploadingFiles: boolean;
  defaultProvider: string | null | undefined;
  nextQueuedUploadPrefix: string | null;
}) =>
  !input.uploadingFiles && Boolean(input.defaultProvider) && input.nextQueuedUploadPrefix !== null;
