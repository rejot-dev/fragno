import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageService } from "./message-service";

let tmpDir: string | undefined;

export const fileMessageService: MessageService = {
  setData: async (messageKey: string, message: string) => {
    if (!tmpDir) {
      tmpDir = await mkdtemp(join(tmpdir(), "fragno-"));
    }

    console.log("[FileMessageService] setData", messageKey);
    const filePath = join(tmpDir, `${messageKey}.txt`);
    await writeFile(filePath, message, {
      flag: "w",
      encoding: "utf8",
    });
  },
  getData: async (messageKey: string) => {
    if (!tmpDir) {
      tmpDir = await mkdtemp(join(tmpdir(), "fragno-"));
    }

    console.log("[FileMessageService] getData", messageKey);
    const filePath = join(tmpDir, `${messageKey}.txt`);
    try {
      const message = await readFile(filePath, "utf8");
      return message;
    } catch {
      return undefined;
    }
  },
};

fileMessageService.setData("default", `Hello World from file:'${tmpDir}/default.txt'`);
