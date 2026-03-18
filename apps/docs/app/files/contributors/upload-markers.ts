const DIRECTORY_MARKER_NAMESPACE = ".fragno";
const DIRECTORY_MARKER_FILENAME = "dir-marker";
const DIRECTORY_MARKER_CONTENT_TYPE = "application/x.fragno-directory-marker";
const DIRECTORY_MARKER_SUFFIX = `/${DIRECTORY_MARKER_NAMESPACE}/${DIRECTORY_MARKER_FILENAME}`;
const DIRECTORY_MARKER_METADATA_KEY = "__docsDirectoryMarker";

export type UploadDirectoryMarkerLike = {
  fileKey: string;
  metadata?: Record<string, unknown> | null;
  contentType?: string | null;
};

export const createUploadDirectoryMarkerMetadata = (): Record<string, unknown> => ({
  [DIRECTORY_MARKER_METADATA_KEY]: true,
});

export const isUploadDirectoryMarker = (file: UploadDirectoryMarkerLike): boolean => {
  if (!file.fileKey.endsWith(DIRECTORY_MARKER_SUFFIX)) {
    return false;
  }

  if (file.contentType === DIRECTORY_MARKER_CONTENT_TYPE) {
    return true;
  }

  const metadata = file.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    metadata[DIRECTORY_MARKER_METADATA_KEY] === true
  );
};

export const toUploadDirectoryMarkerFileKey = (folderKey: string): string => {
  const normalizedFolderKey = folderKey.replace(/^\/+|\/+$/g, "");
  if (!normalizedFolderKey) {
    return `${DIRECTORY_MARKER_NAMESPACE}/${DIRECTORY_MARKER_FILENAME}`;
  }

  return `${normalizedFolderKey}${DIRECTORY_MARKER_SUFFIX}`;
};

export const getUploadDirectoryMarkerFolderKey = (fileKey: string): string | null => {
  if (!fileKey.endsWith(DIRECTORY_MARKER_SUFFIX)) {
    return null;
  }

  const folderKey = fileKey.slice(0, -DIRECTORY_MARKER_SUFFIX.length).replace(/^\/+|\/+$/g, "");
  return folderKey || null;
};

export const getUploadDirectoryMarkerFilename = (): string => DIRECTORY_MARKER_FILENAME;
