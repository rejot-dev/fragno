// upload tools
type UploadCodemodeProvider = {
  /** Read the content of a prepared private upload before commit or discard. */
  readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
  /** Commit a prepared private upload so the file persists. */
  commitPrepared(input: UploadCommitPreparedInput): Promise<UploadCommitPreparedOutput>;
  /** Discard a temporary prepared private upload. */
  discardPrepared(input: UploadDiscardPreparedInput): Promise<UploadDiscardPreparedOutput>;
};
declare const upload: UploadCodemodeProvider;

type UploadReadPreparedInput = {
  file: {
    kind: "prepared-upload";
    scope:
      | {
          kind: "org";
          orgId: string;
        }
      | {
          kind: "user";
          userId: string;
        }
      | {
          kind: "project";
          orgId: string;
          projectId: string;
        };
    uploadId: string;
    provider: string;
    fileKey: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    /** ISO 8601 datetime string. */
    expiresAt: string;
  };
  encoding?: "utf8" | "base64" | "bytes";
  maxBytes?: number;
};
type UploadReadPreparedOutput =
  | {
      file: {
        kind: "prepared-upload";
        scope:
          | {
              kind: "org";
              orgId: string;
            }
          | {
              kind: "user";
              userId: string;
            }
          | {
              kind: "project";
              orgId: string;
              projectId: string;
            };
        uploadId: string;
        provider: string;
        fileKey: string;
        filename: string;
        sizeBytes: number;
        contentType: string;
        /** ISO 8601 datetime string. */
        expiresAt: string;
      };
      byteLength: number;
      encoding: "utf8";
      text: string;
    }
  | {
      file: {
        kind: "prepared-upload";
        scope:
          | {
              kind: "org";
              orgId: string;
            }
          | {
              kind: "user";
              userId: string;
            }
          | {
              kind: "project";
              orgId: string;
              projectId: string;
            };
        uploadId: string;
        provider: string;
        fileKey: string;
        filename: string;
        sizeBytes: number;
        contentType: string;
        /** ISO 8601 datetime string. */
        expiresAt: string;
      };
      byteLength: number;
      encoding: "base64";
      base64: string;
    }
  | {
      file: {
        kind: "prepared-upload";
        scope:
          | {
              kind: "org";
              orgId: string;
            }
          | {
              kind: "user";
              userId: string;
            }
          | {
              kind: "project";
              orgId: string;
              projectId: string;
            };
        uploadId: string;
        provider: string;
        fileKey: string;
        filename: string;
        sizeBytes: number;
        contentType: string;
        /** ISO 8601 datetime string. */
        expiresAt: string;
      };
      byteLength: number;
      encoding: "bytes";
      bytes: Uint8Array;
    };
type UploadCommitPreparedInput = {
  file: {
    kind: "prepared-upload";
    scope:
      | {
          kind: "org";
          orgId: string;
        }
      | {
          kind: "user";
          userId: string;
        }
      | {
          kind: "project";
          orgId: string;
          projectId: string;
        };
    uploadId: string;
    provider: string;
    fileKey: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    /** ISO 8601 datetime string. */
    expiresAt: string;
  };
};
type UploadCommitPreparedOutput = {
  scope:
    | {
        kind: "org";
        orgId: string;
      }
    | {
        kind: "user";
        userId: string;
      }
    | {
        kind: "project";
        orgId: string;
        projectId: string;
      };
  uploadId: string;
  provider: string;
  fileKey: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  kind: "uploaded-file";
};
type UploadDiscardPreparedInput = {
  file: {
    kind: "prepared-upload";
    scope:
      | {
          kind: "org";
          orgId: string;
        }
      | {
          kind: "user";
          userId: string;
        }
      | {
          kind: "project";
          orgId: string;
          projectId: string;
        };
    uploadId: string;
    provider: string;
    fileKey: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    /** ISO 8601 datetime string. */
    expiresAt: string;
  };
};
type UploadDiscardPreparedOutput = {
  discarded: true;
  uploadId: string;
};
