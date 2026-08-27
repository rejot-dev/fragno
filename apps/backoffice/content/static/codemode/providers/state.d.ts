// state tools
type StateCodemodeProvider = {
  /** Read a UTF-8 text file from codemode state. */
  readFile(input: StateReadFileInput): Promise<string>;
  /** Read a file from codemode state as bytes. */
  readFileBytes(input: StateReadFileBytesInput): Promise<StateReadFileBytesOutput>;
  /** Write a UTF-8 text file to mutable codemode state. */
  writeFile(input: StateWriteFileInput): Promise<void>;
  /** Write bytes to mutable codemode state. */
  writeFileBytes(input: StateWriteFileBytesInput): Promise<void>;
  /** Append text or bytes to a file in mutable codemode state. */
  appendFile(input: StateAppendFileInput): Promise<void>;
  /** Check whether a codemode state path exists. */
  exists(input: StateExistsInput): Promise<boolean>;
  /** Read metadata for a codemode state path. */
  stat(input: StateStatInput): Promise<StateStatOutput>;
  /** Read metadata for a codemode state path without following links. */
  lstat(input: StateLstatInput): Promise<StateLstatOutput>;
  /** Create a directory in mutable codemode state. */
  mkdir(input: StateMkdirInput): Promise<void>;
  /** List the names directly below a codemode state directory. */
  readdir(input: StateReaddirInput): Promise<StateReaddirOutput>;
  /** List names and entry types directly below a codemode state directory. */
  readdirWithFileTypes(
    input: StateReaddirWithFileTypesInput,
  ): Promise<StateReaddirWithFileTypesOutput>;
  /** Remove a file or empty directory from mutable codemode state. */
  rm(input: StateRmInput): Promise<void>;
  /** Copy one file within mutable codemode state. */
  cp(input: StateCpInput): Promise<void>;
  /** Move one file within mutable codemode state. */
  mv(input: StateMvInput): Promise<void>;
  /** Resolve and validate a codemode state path. */
  realpath(input: StateRealpathInput): Promise<string>;
  /** Resolve a path against a base path without accessing storage. */
  resolvePath(input: StateResolvePathInput): Promise<string>;
  /** Find codemode state paths matching a glob pattern. */
  glob(input: StateGlobInput): Promise<StateGlobOutput>;
  /** Read and parse a JSON file from codemode state. */
  readJson(input: StateReadJsonInput): Promise<StateReadJsonOutput>;
  /** Serialize and write a JSON value to mutable codemode state. */
  writeJson(input: StateWriteJsonInput): Promise<void>;
  /** Atomically apply text and JSON edits to mutable codemode state files. */
  applyEdits(input: StateApplyEditsInput): Promise<StateApplyEditsOutput>;
  /** Search for text within one codemode state file. */
  searchText(input: StateSearchTextInput): Promise<StateSearchTextOutput>;
  /** Search for text across codemode state files matching a glob pattern. */
  searchFiles(input: StateSearchFilesInput): Promise<StateSearchFilesOutput>;
  /** Hash the bytes of one codemode state file. */
  hashFile(input: StateHashFileInput): Promise<string>;
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
  mode?: number;
} | null;
type StateLstatInput = {
  path: string;
};
type StateLstatOutput = {
  type: "file" | "directory";
  size: number;
  /** ISO 8601 datetime string. */
  mtime: string;
  mode?: number;
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
  query: string;
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
};
type StateHashFileInput = {
  path: string;
  algorithm?: "md5" | "sha1" | "sha256";
};
