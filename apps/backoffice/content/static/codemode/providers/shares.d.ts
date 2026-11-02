// Read-only shares of /workspace folders and blobs with other scopes, read at /shared/<name>/. Read to give another scope access to files without copying them.
type SharesCodemodeProvider = {
  /**
   * Share a /workspace folder, or the blobs under a key prefix, with another scope, read-only and without copying. The other scope reads it at /shared/<name>/ once it accepts the share with shares.accept, until either scope revokes it. A download URL created from a shared blob still works until it expires.
   * Requires `upload.read`.
   */
  create(input: SharesCreateInput): Promise<SharesCreateOutput>;
  /**
   * Accept a folder or blobs another scope shared with this one, so this scope reads them at /shared/<name>/. Accepting a share again returns it under the name it has.
   * Requires `upload.modify`.
   */
  accept(input: SharesAcceptInput): Promise<SharesAcceptOutput>;
  /**
   * List what this scope shared with other scopes and the shares it accepted.
   * Requires `upload.read`.
   */
  list(input: SharesListInput): Promise<SharesListOutput>;
  /**
   * End a share: revoking one this scope shared stops the other scope reading it, and revoking one this scope accepted removes it from /shared.
   * Requires `upload.read`.
   */
  revoke(input: SharesRevokeInput): Promise<void>;
};
declare const shares: SharesCodemodeProvider;

type SharesCreateInput = {
  /** What to share. */
  of:
    | {
        kind: "folder";
        /** A /workspace folder, such as /workspace/reports/2026/. */
        path: string;
      }
    | {
        kind: "blobs";
        /** The blobs whose keys start with this folder-like prefix, such as calls/2026/. */
        prefix: string;
      };
  /** The scope to share it with. */
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
type SharesCreateOutput = {
  shareId: string;
  /** What the share opens: a folder ending in /, or the blobs under a prefix ending in /. */
  of:
    | {
        kind: "folder";
        /** A /workspace folder, such as /workspace/reports/2026/. */
        path: string;
      }
    | {
        kind: "blobs";
        /** The blobs whose keys start with this folder-like prefix, such as calls/2026/. */
        prefix: string;
      };
  /** The scope that may accept and read it. */
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
type SharesAcceptInput = {
  /** The scope that shared it. */
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
  /** The name to read the share under, unique in this scope. Defaults to the share's ID. */
  name?: string;
};
type SharesAcceptOutput = {
  shareId: string;
  /** The name this scope reads the share under. */
  name: string;
  /** The scope that shared it. */
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
  /** What the sharing scope shares, in its own terms. */
  of:
    | {
        kind: "folder";
        /** A /workspace folder, such as /workspace/reports/2026/. */
        path: string;
      }
    | {
        kind: "blobs";
        /** The blobs whose keys start with this folder-like prefix, such as calls/2026/. */
        prefix: string;
      };
  /** Where this scope reads the share, read-only: /shared/<name>/. A folder's files are at this path, and search and glob enter it only when the pattern starts with it. Blobs are under it as keys, for blobs.get, blobs.list, blobs.read, and blobs.createDownloadUrl. */
  path: string;
  /** ISO 8601 datetime string. */
  acceptedAt: string;
};
type SharesListInput = Record<string, unknown>;
type SharesListOutput = {
  shared: {
    shareId: string;
    /** What the share opens: a folder ending in /, or the blobs under a prefix ending in /. */
    of:
      | {
          kind: "folder";
          /** A /workspace folder, such as /workspace/reports/2026/. */
          path: string;
        }
      | {
          kind: "blobs";
          /** The blobs whose keys start with this folder-like prefix, such as calls/2026/. */
          prefix: string;
        };
    /** The scope that may accept and read it. */
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
    /** The name this scope reads the share under. */
    name: string;
    /** The scope that shared it. */
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
    /** What the sharing scope shares, in its own terms. */
    of:
      | {
          kind: "folder";
          /** A /workspace folder, such as /workspace/reports/2026/. */
          path: string;
        }
      | {
          kind: "blobs";
          /** The blobs whose keys start with this folder-like prefix, such as calls/2026/. */
          prefix: string;
        };
    /** Where this scope reads the share, read-only: /shared/<name>/. A folder's files are at this path, and search and glob enter it only when the pattern starts with it. Blobs are under it as keys, for blobs.get, blobs.list, blobs.read, and blobs.createDownloadUrl. */
    path: string;
    /** ISO 8601 datetime string. */
    acceptedAt: string;
  }[];
};
type SharesRevokeInput = {
  shareId: string;
};
