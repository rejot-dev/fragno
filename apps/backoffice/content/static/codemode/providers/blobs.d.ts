// Large files kept outside /workspace, uploaded and downloaded through presigned storage URLs. Read to store or share a file too large for the workspace.
type BlobsCodemodeProvider = {
  /**
   * Start storing a large file as a blob of this scope. Blobs are kept apart from /workspace files: state.* does not see them and their bytes never pass through Backoffice. Whoever holds the file PUTs its bytes to `url` with `headers` before `expiresAt`: the URL works from sandboxes, and can be given to people and services outside Backoffice. When the file is on the user's computer, give them that command with the URL and their file filled in, for example `curl -sS --fail-with-body -X PUT -H "Content-Type: $contentType" -T file "$url"`. Then call blobs.completeUpload. The size need not be known in advance; a blob may be at most 5363466240 bytes. Creating another upload for the same key replaces an unfinished one, and completing it replaces the existing blob.
   * Requires `upload.modify`.
   */
  createUpload(input: BlobsCreateUploadInput): Promise<BlobsCreateUploadOutput>;
  /**
   * Finish an upload after its bytes were PUT, and return the stored blob with its size. It fails when storage holds no bytes for the upload yet.
   * Requires `upload.modify`.
   */
  completeUpload(input: BlobsCompleteUploadInput): Promise<BlobsCompleteUploadOutput>;
  /**
   * Get a blob's metadata by key, or null when the scope has no such blob.
   * Requires `upload.read`.
   */
  get(input: BlobsGetInput): Promise<BlobsGetOutput>;
  /**
   * List this scope's blobs by key, optionally only those whose key starts with prefix.
   * Requires `upload.read`.
   */
  list(input: BlobsListInput): Promise<BlobsListOutput>;
  /**
   * Create a temporary URL that reads a blob straight from storage without credentials. It works from sandboxes, browsers, and services outside Backoffice. Anyone holding the URL can read the blob until it expires.
   * Requires `upload.read`.
   */
  createDownloadUrl(input: BlobsCreateDownloadUrlInput): Promise<BlobsCreateDownloadUrlOutput>;
  /**
   * Delete a blob and its stored bytes.
   * Requires `upload.modify`.
   */
  delete(input: BlobsDeleteInput): Promise<void>;
};
declare const blobs: BlobsCodemodeProvider;

type BlobsCreateUploadInput = {
  /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
  key: string;
  contentType?: string;
};
type BlobsCreateUploadOutput = {
  /** Pass to blobs.completeUpload once the bytes are stored. */
  uploadId: string;
  key: string;
  /** Presigned storage URL that accepts one PUT of the blob's bytes, from sandboxes or anywhere else. */
  url: string;
  /** Headers the PUT must send unchanged, as they are part of the signature. */
  headers: {
    [key: string]: string;
  };
  /** The URL stops working, and an uncompleted upload is discarded, at this time. */
  expiresAt: string;
};
type BlobsCompleteUploadInput = {
  uploadId: string;
};
type BlobsCompleteUploadOutput = {
  key: string;
  sizeBytes: number;
  contentType: string;
};
type BlobsGetInput = {
  /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
  key: string;
};
type BlobsGetOutput = {
  key: string;
  sizeBytes: number;
  contentType: string;
} | null;
type BlobsListInput = {
  prefix?: string;
  cursor?: string;
};
type BlobsListOutput = {
  blobs: {
    key: string;
    sizeBytes: number;
    contentType: string;
  }[];
  /** Pass to blobs.list for the next page; null at the end. */
  cursor: string | null;
};
type BlobsCreateDownloadUrlInput = {
  /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
  key: string;
};
type BlobsCreateDownloadUrlOutput = {
  /** Presigned storage URL; a GET returns the blob's bytes. */
  url: string;
  /** ISO 8601 datetime string. */
  expiresAt: string;
};
type BlobsDeleteInput = {
  /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
  key: string;
};
