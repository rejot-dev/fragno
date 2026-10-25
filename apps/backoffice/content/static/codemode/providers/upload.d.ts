// Prepared uploads, sandbox file URLs, and upload storage. Read to handle an uploaded file or move files to a sandbox.
type UploadCodemodeProvider = {
  /** Read the content of a prepared private upload before commit or discard. */
  readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
  /** Commit a prepared private upload so the file persists. */
  commitPrepared(input: UploadCommitPreparedInput): Promise<UploadCommitPreparedOutput>;
  /** Discard a temporary prepared private upload. */
  discardPrepared(input: UploadDiscardPreparedInput): Promise<UploadDiscardPreparedOutput>;
  /** Create a temporary URL that sandbox commands use to read workspace files without credentials; it may not work outside sandboxes. A file path links the file: `curl -sS --fail-with-body "$url" -o file`. A folder or glob links an uncompressed tar archive of up to 500 matching files named relative to `root`: `curl -sS --fail-with-body "$url" | tar -x -C dir`. When the archive response has an X-Next-Cursor header, request the URL again with ?cursor=<value> for the next files. Anyone holding the URL can read these files until it expires. */
  createDownloadLink(input: UploadCreateDownloadLinkInput): Promise<UploadCreateDownloadLinkOutput>;
  /** Create a temporary URL that sandbox commands use to write workspace files without credentials; it may not work outside sandboxes. Writes replace existing files. Each file may be at most 1.9 MB. A file path accepts the file: `curl -sS --fail-with-body -H "Expect:" -T file "$url"`. A folder or glob accepts an uncompressed tar archive of at most 200 regular files and 25 MB, without symlinks, whose entry names are relative to `root` and must match: `tar -ch -C dir . | curl -sS --fail-with-body -H "Expect:" -T - "$url"`. Push only the files the task produced, never a whole project; an archive is written all-or-nothing. A successful write returns `{"fileCount","sizeBytes"}`. Anyone holding the URL can write these files until it expires. */
  createUploadLink(input: UploadCreateUploadLinkInput): Promise<UploadCreateUploadLinkOutput>;
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
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                    }
                  | {
                      kind: "user";
                      userId: string;
                    };
                appId: string;
              };
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
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  };
              appId: string;
            }
          | {
              kind: "project";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  }
                | {
                    kind: "app";
                    owner:
                      | {
                          kind: "org";
                          orgId: string;
                        }
                      | {
                          kind: "user";
                          userId: string;
                        };
                    appId: string;
                  };
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
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  };
              appId: string;
            }
          | {
              kind: "project";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  }
                | {
                    kind: "app";
                    owner:
                      | {
                          kind: "org";
                          orgId: string;
                        }
                      | {
                          kind: "user";
                          userId: string;
                        };
                    appId: string;
                  };
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
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  };
              appId: string;
            }
          | {
              kind: "project";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  }
                | {
                    kind: "app";
                    owner:
                      | {
                          kind: "org";
                          orgId: string;
                        }
                      | {
                          kind: "user";
                          userId: string;
                        };
                    appId: string;
                  };
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
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                    }
                  | {
                      kind: "user";
                      userId: string;
                    };
                appId: string;
              };
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
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
            }
          | {
              kind: "user";
              userId: string;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
            }
          | {
              kind: "user";
              userId: string;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                  }
                | {
                    kind: "user";
                    userId: string;
                  };
              appId: string;
            };
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
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
              }
            | {
                kind: "user";
                userId: string;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                    }
                  | {
                      kind: "user";
                      userId: string;
                    };
                appId: string;
              };
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
type UploadCreateDownloadLinkInput = {
  /** A /workspace file path, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv. */
  path: string;
  /** How long the link works. Defaults to 900 seconds. */
  expiresInSeconds?: number;
};
type UploadCreateDownloadLinkOutput =
  | {
      /** The URL's body is the file itself. */
      format: "file";
      /** Use unchanged in a sandbox command; its host may resolve only inside sandboxes. */
      url: string;
      path: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    }
  | {
      /** The URL's body is a tar archive of the matching files. */
      format: "tar";
      /** Use unchanged in a sandbox command; its host may resolve only inside sandboxes. */
      url: string;
      glob: string;
      /** The /workspace folder that archive entry names are relative to. */
      root: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    };
type UploadCreateUploadLinkInput = {
  /** A /workspace file path, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv. */
  path: string;
  /** How long the link works. Defaults to 900 seconds. */
  expiresInSeconds?: number;
};
type UploadCreateUploadLinkOutput =
  | {
      /** The URL's body is the file itself. */
      format: "file";
      /** Use unchanged in a sandbox command; its host may resolve only inside sandboxes. */
      url: string;
      path: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    }
  | {
      /** The URL's body is a tar archive of the matching files. */
      format: "tar";
      /** Use unchanged in a sandbox command; its host may resolve only inside sandboxes. */
      url: string;
      glob: string;
      /** The /workspace folder that archive entry names are relative to. */
      root: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    };
type UploadGetStorageOutput = UploadStorage;
type UploadConfigureStorageInput = UploadStorageConfigureInput;
type UploadConfigureStorageOutput = UploadStorage;
