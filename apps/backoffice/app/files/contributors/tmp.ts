import { InMemoryFs } from "just-bash";

import type { FileContributor, FileMountMetadata } from "../types";

export const TMP_FILE_CONTRIBUTOR_ID = "tmp";
export const TMP_FILE_MOUNT_ID = "tmp";
export const TMP_FILE_MOUNT_POINT = "/tmp";

export const tmpFileMount: FileMountMetadata = {
  id: TMP_FILE_MOUNT_ID,
  kind: "custom",
  mountPoint: TMP_FILE_MOUNT_POINT,
  title: "Temp",
  readOnly: false,
  persistence: "ephemeral",
  description: "Ephemeral in-memory scratch space for temporary files.",
};

export const tmpFileContributor: FileContributor = {
  ...tmpFileMount,
  async createFileSystem() {
    const fs = new InMemoryFs();
    await fs.mkdir(TMP_FILE_MOUNT_POINT, { recursive: true });

    return {
      stat: fs.stat.bind(fs),
      lstat: fs.lstat.bind(fs),
      readFile: fs.readFile.bind(fs),
      readFileBuffer: fs.readFileBuffer.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      appendFile: fs.appendFile.bind(fs),
      exists: fs.exists.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      readdir: fs.readdir.bind(fs),
      ...(typeof fs.readdirWithFileTypes === "function"
        ? {
            readdirWithFileTypes: fs.readdirWithFileTypes.bind(fs),
          }
        : {}),
      rm: fs.rm.bind(fs),
      cp: fs.cp.bind(fs),
      mv: fs.mv.bind(fs),
      resolvePath: fs.resolvePath.bind(fs),
      getAllPaths: fs.getAllPaths.bind(fs),
      chmod: fs.chmod.bind(fs),
      symlink: fs.symlink.bind(fs),
      link: fs.link.bind(fs),
      readlink: fs.readlink.bind(fs),
      realpath: fs.realpath.bind(fs),
      utimes: fs.utimes.bind(fs),
    };
  },
};
