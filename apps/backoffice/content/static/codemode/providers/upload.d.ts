// upload tools
type UploadCodemodeProvider = {
  /** Read the content of a prepared private upload before commit or discard. */
  readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
  /** Commit a prepared private upload so the file persists. */
  commitPrepared(input: UploadCommitPreparedInput): Promise<UploadCommitPreparedOutput>;
  /** Discard a temporary prepared private upload. */
  discardPrepared(input: UploadDiscardPreparedInput): Promise<UploadDiscardPreparedOutput>;
  /** Read the organization's upload storage: the configured providers and the one new uploads use. */
  getStorage(): Promise<UploadGetStorageOutput>;
  /** Store one upload storage provider's configuration for the organization, replacing that provider's earlier configuration. Secrets are never returned. */
  configureStorage(input: UploadConfigureStorageInput): Promise<UploadConfigureStorageOutput>;
};
declare const upload: UploadCodemodeProvider;

type UploadStorage = {
  /** The provider new uploads use; null until one is configured. */
  defaultProvider: UploadProvider | null;
  /** Providers with stored configuration. */
  providers: UploadProvider[];
};
type UploadProvider = "database" | "r2" | "r2-binding";
type UploadStorageConfigureInput =
  | {
      /** Files stored in Backoffice's own database. */
      provider: "database";
      /** Whether new uploads use this provider. Files already stored stay where they are. */
      default: boolean;
    }
  | {
      /** An R2 bucket bound to the Worker. */
      provider: "r2-binding";
      /** Name of the Worker's R2 bucket binding. */
      bindingName: string;
      /** Whether new uploads use this provider. Files already stored stay where they are. */
      default: boolean;
    }
  | {
      /** An R2 bucket reached through its S3 API. */
      provider: "r2";
      bucket: string;
      /** The account's S3 API endpoint. */
      endpoint: string;
      /** Secret. */
      accessKeyId: string;
      /** Secret. */
      secretAccessKey: string;
      /** Usually auto. */
      region: string;
      /** Secret; null when unused. */
      sessionToken: string | null;
      /** Address the bucket in the path rather than the host name. */
      pathStyle: boolean;
      /** Whether new uploads use this provider. Files already stored stay where they are. */
      default: boolean;
    };
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
type UploadGetStorageOutput = UploadStorage;
type UploadConfigureStorageInput = UploadStorageConfigureInput;
type UploadConfigureStorageOutput = UploadStorage;
