// Files in /workspace and /static, and links that share them. Read for file work beyond searching, reading, and writing, or to share or move files.
type StateCodemodeProvider = {
  /**
   * Read a UTF-8 text file from codemode state.
   * Requires `upload.read`.
   */
  readFile(input: StateReadFileInput): Promise<string>;
  /**
   * Read a file from codemode state as bytes.
   * Requires `upload.read`.
   */
  readFileBytes(input: StateReadFileBytesInput): Promise<StateReadFileBytesOutput>;
  /**
   * Write a UTF-8 text file to mutable codemode state.
   * Requires `upload.modify`.
   */
  writeFile(input: StateWriteFileInput): Promise<void>;
  /**
   * Write bytes to mutable codemode state.
   * Requires `upload.modify`.
   */
  writeFileBytes(input: StateWriteFileBytesInput): Promise<void>;
  /**
   * Append text or bytes to a file in mutable codemode state.
   * Requires `upload.modify`.
   */
  appendFile(input: StateAppendFileInput): Promise<void>;
  /**
   * Check whether a codemode state path exists.
   * Requires `upload.read`.
   */
  exists(input: StateExistsInput): Promise<boolean>;
  /**
   * Read metadata for a codemode state path.
   * Requires `upload.read`.
   */
  stat(input: StateStatInput): Promise<StateStatOutput>;
  /**
   * Read metadata for a codemode state path without following links.
   * Requires `upload.read`.
   */
  lstat(input: StateLstatInput): Promise<StateLstatOutput>;
  /**
   * Create a directory in mutable codemode state.
   * Requires `upload.modify`.
   */
  mkdir(input: StateMkdirInput): Promise<void>;
  /**
   * List the names directly below a codemode state directory.
   * Requires `upload.read`.
   */
  readdir(input: StateReaddirInput): Promise<StateReaddirOutput>;
  /**
   * List names and entry types directly below a codemode state directory.
   * Requires `upload.read`.
   */
  readdirWithFileTypes(
    input: StateReaddirWithFileTypesInput,
  ): Promise<StateReaddirWithFileTypesOutput>;
  /**
   * Remove a file or empty directory from mutable codemode state.
   * Requires `upload.modify`.
   */
  rm(input: StateRmInput): Promise<void>;
  /**
   * Copy one file within mutable codemode state.
   * Requires `upload.read` and `upload.modify`.
   */
  cp(input: StateCpInput): Promise<void>;
  /**
   * Move one file within mutable codemode state.
   * Requires `upload.read` and `upload.modify`.
   */
  mv(input: StateMvInput): Promise<void>;
  /**
   * Resolve and validate a codemode state path.
   * Requires `upload.read`.
   */
  realpath(input: StateRealpathInput): Promise<string>;
  /** Resolve a path against a base path without accessing storage. */
  resolvePath(input: StateResolvePathInput): Promise<string>;
  /**
   * Find codemode state paths matching a glob pattern.
   * Requires `upload.read`.
   */
  glob(input: StateGlobInput): Promise<StateGlobOutput>;
  /**
   * Read and parse a JSON file from codemode state.
   * Requires `upload.read`.
   */
  readJson(input: StateReadJsonInput): Promise<StateReadJsonOutput>;
  /**
   * Serialize and write a JSON value to mutable codemode state.
   * Requires `upload.modify`.
   */
  writeJson(input: StateWriteJsonInput): Promise<void>;
  /**
   * Atomically apply text and JSON edits to mutable codemode state files.
   * Requires `upload.modify`.
   */
  applyEdits(input: StateApplyEditsInput): Promise<StateApplyEditsOutput>;
  /**
   * Search for text within one codemode state file.
   * Requires `upload.read`.
   */
  searchText(input: StateSearchTextInput): Promise<StateSearchTextOutput>;
  /**
   * Search codemode state files matching a glob pattern for lines containing any of the keywords.
   * Requires `upload.read`.
   */
  searchFiles(input: StateSearchFilesInput): Promise<StateSearchFilesOutput>;
  /**
   * Hash the bytes of one codemode state file.
   * Requires `upload.read`.
   */
  hashFile(input: StateHashFileInput): Promise<string>;
  /**
   * Create a temporary URL that reads workspace files without credentials. Give `url` to people and services outside Backoffice; browsers download the file. Sandbox commands use `sandboxUrl`. A file path links the file: `curl -sS --fail-with-body "$sandboxUrl" -o file`. A folder or glob links an uncompressed tar archive of up to 500 matching files named relative to `root`: `curl -sS --fail-with-body "$sandboxUrl" | tar -x -C dir`. When the archive response has an X-Next-Cursor header, request the URL again with ?cursor=<value> for the next files. Anyone holding the URL can read these files until it expires.
   * Requires `upload.read`.
   */
  createDownloadLink(input: StateCreateDownloadLinkInput): Promise<StateCreateDownloadLinkOutput>;
  /**
   * Create a temporary URL that writes workspace files without credentials. Give `url` to services outside Backoffice; sandbox commands use `sandboxUrl`. Writes replace existing files. Each file may be at most 1900000 bytes. A file path accepts the file: `curl -sS --fail-with-body -H "Expect:" -T file "$sandboxUrl"`. A folder or glob accepts an uncompressed tar archive of at most 200 regular files and 25 MB, without symlinks, whose entry names are relative to `root` and must match: `tar -ch -C dir . | curl -sS --fail-with-body -H "Expect:" -T - "$sandboxUrl"`. Push only the files the task produced, never a whole project; an archive is written all-or-nothing. A successful write returns `{"fileCount","sizeBytes"}`. Anyone holding the URL can write these files until it expires.
   * Requires `upload.modify`.
   */
  createUploadLink(input: StateCreateUploadLinkInput): Promise<StateCreateUploadLinkOutput>;
  /**
   * Share a /workspace folder with another scope, read-only and without copying. The other scope reads it in /shared once it accepts the share with state.acceptShare, until either scope revokes it.
   * Requires `upload.read`.
   */
  share(input: StateShareInput): Promise<StateShareOutput>;
  /**
   * Accept a folder another scope shared with this one, so this scope reads it at /shared/<name>/. Accepting a share again returns it under the name it has.
   * Requires `upload.modify`.
   */
  acceptShare(input: StateAcceptShareInput): Promise<StateAcceptShareOutput>;
  /**
   * List the folders this scope shared with other scopes and the shares it accepted from them.
   * Requires `upload.read`.
   */
  listShares(input: StateListSharesInput): Promise<StateListSharesOutput>;
  /**
   * End a share: revoking one this scope shared stops the other scope reading it, and revoking one this scope accepted removes it from /shared.
   * Requires `upload.read`.
   */
  revokeShare(input: StateRevokeShareInput): Promise<void>;
  /**
   * Look at a PNG, JPEG, or WebP image in state yourself: it follows the program's output in your tool result. Only agents can view images, each at most 2000×2000 pixels; one program views at most 8 images of 1125000 bytes together.
   * Requires `upload.read`.
   */
  viewImage(input: StateViewImageInput): Promise<StateViewImageOutput>;
};
declare const state: StateCodemodeProvider;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
type StateReadFileInput = {
  path: string;
};
type StateReadFileBytesInput = {
  path: string;
};
type StateReadFileBytesOutput = Uint8Array;
type StateWriteFileInput = {
  path: string;
  content: string;
};
type StateWriteFileBytesInput = {
  path: string;
  content: Uint8Array;
};
type StateAppendFileInput = {
  path: string;
  content: string | Uint8Array;
};
type StateExistsInput = {
  path: string;
};
type StateStatInput = {
  path: string;
};
type StateStatOutput = {
  type: "file" | "directory";
  size: number;
  /** ISO 8601 datetime string. */
  mtime: string;
} | null;
type StateLstatInput = {
  path: string;
};
type StateLstatOutput = {
  type: "file" | "directory";
  size: number;
  /** ISO 8601 datetime string. */
  mtime: string;
} | null;
type StateMkdirInput = {
  path: string;
};
type StateReaddirInput = {
  path: string;
};
type StateReaddirOutput = string[];
type StateReaddirWithFileTypesInput = {
  path: string;
};
type StateReaddirWithFileTypesOutput = {
  name: string;
  type: "file" | "directory";
}[];
type StateRmInput = {
  path: string;
  options?: {
    force?: boolean;
  };
};
type StateCpInput = {
  src: string;
  dest: string;
};
type StateMvInput = {
  src: string;
  dest: string;
};
type StateRealpathInput = {
  path: string;
};
type StateResolvePathInput = {
  base: string;
  path: string;
};
type StateGlobInput = {
  pattern: string;
};
type StateGlobOutput = string[];
type StateReadJsonInput = {
  path: string;
};
type StateReadJsonOutput = JsonValue;
type StateWriteJsonInput = {
  path: string;
  value: JsonValue;
  options?: {
    spaces?: number;
  };
};
type StateApplyEditsInput = {
  edits: (
    | {
        kind: "write";
        path: string;
        content: string;
      }
    | {
        kind: "replace";
        path: string;
        search: string;
        replacement: string;
        options?: {
          caseSensitive?: boolean;
          regex?: boolean;
          wholeWord?: boolean;
          maxMatches?: number;
        };
      }
    | {
        kind: "writeJson";
        path: string;
        value: JsonValue;
        options?: {
          spaces?: number;
        };
      }
  )[];
};
type StateApplyEditsOutput = {
  edits: {
    path: string;
    changed: boolean;
    content: string;
    diff: string;
  }[];
  totalChanged: number;
};
type StateSearchTextInput = {
  path: string;
  query: string;
  options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    contextBefore?: number;
    contextAfter?: number;
    maxMatches?: number;
    regex?: boolean;
  };
};
type StateSearchTextOutput = {
  line: number;
  column: number;
  match: string;
  lineText: string;
  beforeLines?: string[];
  afterLines?: string[];
}[];
type StateSearchFilesInput = {
  pattern: string;
  keywords: string[];
  options?: {
    upload?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      contextBefore?: number;
      contextAfter?: number;
      maxMatches?: number;
      cursor?: string;
    };
    static?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      contextBefore?: number;
      contextAfter?: number;
      maxMatches?: number;
      cursor?: string;
    };
    shared?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      contextBefore?: number;
      contextAfter?: number;
      maxMatches?: number;
      cursor?: string;
    };
  };
};
type StateSearchFilesOutput = {
  upload: {
    results: {
      path: string;
      matches: {
        line: number;
        column: number;
        match: string;
        lineText: string;
        beforeLines?: string[];
        afterLines?: string[];
      }[];
    }[];
    cursor?: string;
    hasMore: boolean;
  };
  static: {
    results: {
      path: string;
      matches: {
        line: number;
        column: number;
        match: string;
        lineText: string;
        beforeLines?: string[];
        afterLines?: string[];
      }[];
    }[];
    cursor?: string;
    hasMore: boolean;
  };
  /** Present when the pattern names a share: /shared/<name>/... */
  shared?: {
    results: {
      path: string;
      matches: {
        line: number;
        column: number;
        match: string;
        lineText: string;
        beforeLines?: string[];
        afterLines?: string[];
      }[];
    }[];
    cursor?: string;
    hasMore: boolean;
  };
};
type StateHashFileInput = {
  path: string;
  algorithm?: "md5" | "sha1" | "sha256";
};
type StateCreateDownloadLinkInput = {
  /** A path in this scope's Backoffice workspace, the files state.readFile reads, not a path inside a sandbox: a /workspace file, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv. */
  path: string;
  /** How long the link works. Defaults to 900 seconds. */
  expiresInSeconds?: number;
};
type StateCreateDownloadLinkOutput =
  | {
      /** The URL's body is the file itself. */
      format: "file";
      /** The public URL, for people and services outside Backoffice. */
      url: string;
      /** The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes. */
      sandboxUrl: string;
      /** The linked file's path in the Backoffice workspace. */
      path: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    }
  | {
      /** The URL's body is a tar archive of the matching files. */
      format: "tar";
      /** The public URL, for people and services outside Backoffice. */
      url: string;
      /** The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes. */
      sandboxUrl: string;
      /** The Backoffice workspace paths the link matches. */
      glob: string;
      /** The Backoffice workspace folder that archive entry names are relative to. */
      root: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    };
type StateCreateUploadLinkInput = {
  /** A path in this scope's Backoffice workspace, the files state.readFile reads, not a path inside a sandbox: a /workspace file, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv. */
  path: string;
  /** How long the link works. Defaults to 900 seconds. */
  expiresInSeconds?: number;
};
type StateCreateUploadLinkOutput =
  | {
      /** The URL's body is the file itself. */
      format: "file";
      /** The public URL, for people and services outside Backoffice. */
      url: string;
      /** The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes. */
      sandboxUrl: string;
      /** The linked file's path in the Backoffice workspace. */
      path: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    }
  | {
      /** The URL's body is a tar archive of the matching files. */
      format: "tar";
      /** The public URL, for people and services outside Backoffice. */
      url: string;
      /** The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes. */
      sandboxUrl: string;
      /** The Backoffice workspace paths the link matches. */
      glob: string;
      /** The Backoffice workspace folder that archive entry names are relative to. */
      root: string;
      /** ISO 8601 datetime string. */
      expiresAt: string;
    };
type StateShareInput = {
  /** The /workspace folder to share, such as /workspace/reports/2026/. */
  path: string;
  /** The scope to share the folder with. */
  with:
    | {
        kind: "org";
        orgId: string;
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction?: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction?: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      };
};
type StateShareOutput = {
  shareId: string;
  /** The shared /workspace folder, ending in /. */
  path: string;
  /** The scope that may accept and read the folder. */
  with:
    | {
        kind: "org";
        orgId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      };
  /** ISO 8601 datetime string. */
  sharedAt: string;
};
type StateAcceptShareInput = {
  /** The scope that shared the folder. */
  from:
    | {
        kind: "org";
        orgId: string;
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction?: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction?: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      };
  shareId: string;
  /** The name to mount the share under, unique in this scope. Defaults to the share's ID. */
  name?: string;
};
type StateAcceptShareOutput = {
  shareId: string;
  /** The name this scope mounts the share under. */
  name: string;
  /** The scope that shared the folder. */
  from:
    | {
        kind: "org";
        orgId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      };
  /** Where this scope reads the folder, read-only: /shared/<name>/. Search and glob enter it only when the pattern starts with this path. */
  path: string;
  /** The folder in the sharing scope's /workspace. */
  sourcePath: string;
  /** ISO 8601 datetime string. */
  acceptedAt: string;
};
type StateListSharesInput = Record<string, unknown>;
type StateListSharesOutput = {
  shared: {
    shareId: string;
    /** The shared /workspace folder, ending in /. */
    path: string;
    /** The scope that may accept and read the folder. */
    with:
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "user";
          userId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "user";
                      userId: string;
                      jurisdiction: "eu" | "us" | null;
                    };
                appId: string;
              };
          projectId: string;
        };
    /** ISO 8601 datetime string. */
    sharedAt: string;
  }[];
  accepted: {
    shareId: string;
    /** The name this scope mounts the share under. */
    name: string;
    /** The scope that shared the folder. */
    from:
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "user";
          userId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "user";
                      userId: string;
                      jurisdiction: "eu" | "us" | null;
                    };
                appId: string;
              };
          projectId: string;
        };
    /** Where this scope reads the folder, read-only: /shared/<name>/. Search and glob enter it only when the pattern starts with this path. */
    path: string;
    /** The folder in the sharing scope's /workspace. */
    sourcePath: string;
    /** ISO 8601 datetime string. */
    acceptedAt: string;
  }[];
};
type StateRevokeShareInput = {
  shareId: string;
};
type StateViewImageInput = {
  path: string;
};
type StateViewImageOutput = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};
