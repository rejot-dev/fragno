import { renderSystemGuidance } from "@/files";
import type { IFileSystem } from "@/files/interface";

import { CODEMODE_STATE_DTS_PATH, CODEMODE_SYSTEM_DTS_PATH } from "./codemode-dts";

export const renderCodemodeSystemPrompt = async ({
  fileSystem,
  guidance,
}: {
  fileSystem: IFileSystem;
  guidance: string;
}) =>
  renderSystemGuidance({
    guidance,
    codemodeDts: await fileSystem.readFile(CODEMODE_SYSTEM_DTS_PATH),
    stateDts: await fileSystem.readFile(CODEMODE_STATE_DTS_PATH),
  });
