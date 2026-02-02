#!/usr/bin/env node

import { cli, define } from "gunshi";
import type { Args, Command } from "gunshi";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadsCreateCommand } from "./commands/uploads/create.js";
import { uploadsGetCommand } from "./commands/uploads/get.js";
import { uploadsProgressCommand } from "./commands/uploads/progress.js";
import { uploadsPartsUrlsCommand } from "./commands/uploads/parts-urls.js";
import { uploadsPartsListCommand } from "./commands/uploads/parts-list.js";
import { uploadsPartsCompleteCommand } from "./commands/uploads/parts-complete.js";
import { uploadsCompleteCommand } from "./commands/uploads/complete.js";
import { uploadsAbortCommand } from "./commands/uploads/abort.js";
import { uploadsContentCommand } from "./commands/uploads/content.js";
import { uploadsTransferCommand } from "./commands/uploads/transfer.js";
import { filesUploadCommand } from "./commands/files/upload.js";
import { filesListCommand } from "./commands/files/list.js";
import { filesGetCommand } from "./commands/files/get.js";
import { filesUpdateCommand } from "./commands/files/update.js";
import { filesDeleteCommand } from "./commands/files/delete.js";
import { filesDownloadUrlCommand } from "./commands/files/download-url.js";
import { filesDownloadCommand } from "./commands/files/download.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const version = packageJson.version as string;

export const uploadsCommand = define({
  name: "uploads",
  description: "Upload session commands",
});

export const filesCommand = define({
  name: "files",
  description: "File commands",
});

const uploadsSubCommands: Map<string, Command<Args>> = new Map();
uploadsSubCommands.set("create", uploadsCreateCommand as Command<Args>);
uploadsSubCommands.set("get", uploadsGetCommand as Command<Args>);
uploadsSubCommands.set("progress", uploadsProgressCommand as Command<Args>);
uploadsSubCommands.set("parts-urls", uploadsPartsUrlsCommand as Command<Args>);
uploadsSubCommands.set("parts-list", uploadsPartsListCommand as Command<Args>);
uploadsSubCommands.set("parts-complete", uploadsPartsCompleteCommand as Command<Args>);
uploadsSubCommands.set("complete", uploadsCompleteCommand as Command<Args>);
uploadsSubCommands.set("abort", uploadsAbortCommand as Command<Args>);
uploadsSubCommands.set("content", uploadsContentCommand as Command<Args>);
uploadsSubCommands.set("transfer", uploadsTransferCommand as Command<Args>);

const filesSubCommands: Map<string, Command<Args>> = new Map();
filesSubCommands.set("upload", filesUploadCommand as Command<Args>);
filesSubCommands.set("list", filesListCommand as Command<Args>);
filesSubCommands.set("get", filesGetCommand as Command<Args>);
filesSubCommands.set("update", filesUpdateCommand as Command<Args>);
filesSubCommands.set("delete", filesDeleteCommand as Command<Args>);
filesSubCommands.set("download-url", filesDownloadUrlCommand as Command<Args>);
filesSubCommands.set("download", filesDownloadCommand as Command<Args>);

const printMainHelp = () => {
  console.log("Upload management CLI for Fragno");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-upload <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  uploads              Manage upload sessions");
  console.log("  files                Manage files");
  console.log("");
  console.log("GLOBAL OPTIONS:");
  console.log("  -b, --base-url        Upload fragment base URL");
  console.log("  -H, --header          Extra HTTP header (repeatable)");
  console.log("  --timeout             Request timeout in ms (default: 15000)");
  console.log("  --retries             Retry count for network/5xx/429 (default: 2)");
  console.log("  --retry-delay         Retry delay in ms (default: 500)");
  console.log("");
  console.log("ENVIRONMENT:");
  console.log("  FRAGNO_UPLOAD_BASE_URL     Default base URL");
  console.log("  FRAGNO_UPLOAD_HEADERS      Extra headers separated by ';' or newlines");
  console.log("  FRAGNO_UPLOAD_TIMEOUT_MS   Default timeout in ms");
  console.log("  FRAGNO_UPLOAD_RETRIES      Default retry count");
  console.log("  FRAGNO_UPLOAD_RETRY_DELAY_MS Default retry delay in ms");
  console.log("");
  console.log("EXAMPLES:");
  console.log(
    "  fragno-upload uploads create -b https://host/api/uploads --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain",
  );
  console.log("  fragno-upload uploads get -b https://host/api/uploads -i upl_123");
  console.log(
    "  fragno-upload uploads transfer -b https://host/api/uploads -f ./demo.txt --file-key s~Zm9v",
  );
  console.log("  fragno-upload files list -b https://host/api/uploads --prefix s~Zm9v.");
  console.log(
    "  fragno-upload files download -b https://host/api/uploads --file-key s~Zm9v -o ./download.txt",
  );
};

const printUploadsHelp = () => {
  console.log("Upload session commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-upload uploads <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  create              Create an upload session");
  console.log("  get                 Get upload status");
  console.log("  progress            Record upload progress");
  console.log("  parts-urls          Get signed URLs for multipart upload");
  console.log("  parts-list          List uploaded parts");
  console.log("  parts-complete      Record completed parts");
  console.log("  complete            Complete an upload");
  console.log("  abort               Abort an upload");
  console.log("  content             Upload file bytes via proxy upload");
  console.log("  transfer            Create an upload and transfer a file");
  console.log("");
  console.log("EXAMPLES:");
  console.log(
    "  fragno-upload uploads create -b https://host/api/uploads --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain",
  );
  console.log("  fragno-upload uploads get -b https://host/api/uploads -i upl_123");
  console.log(
    "  fragno-upload uploads transfer -b https://host/api/uploads -f ./demo.txt --file-key s~Zm9v",
  );
};

const printFilesHelp = () => {
  console.log("File commands");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-upload files <COMMAND>");
  console.log("");
  console.log("COMMANDS:");
  console.log("  upload              Upload a file via /files");
  console.log("  list                List files");
  console.log("  get                 Get file metadata");
  console.log("  update              Update file metadata");
  console.log("  delete              Delete a file");
  console.log("  download-url        Get a signed download URL");
  console.log("  download            Download file contents");
  console.log("");
  console.log("EXAMPLES:");
  console.log(
    "  fragno-upload files upload -b https://host/api/uploads -f ./demo.txt --file-key s~Zm9v",
  );
  console.log("  fragno-upload files list -b https://host/api/uploads --prefix s~Zm9v.");
  console.log(
    "  fragno-upload files download -b https://host/api/uploads --file-key s~Zm9v -o ./download.txt",
  );
};

export async function run() {
  try {
    const args = process.argv.slice(2);

    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      printMainHelp();
      return;
    }

    if (args[0] === "--version" || args[0] === "-v") {
      console.log(version);
      return;
    }

    if (args[0] === "uploads") {
      const subCommandName = args[1];
      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        printUploadsHelp();
        return;
      }
      if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
        return;
      }

      const subCommand = uploadsSubCommands.get(subCommandName);
      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        console.log("Run 'fragno-upload uploads --help' for available commands.");
        process.exit(1);
      }

      await cli(args.slice(2), subCommand, {
        name: `fragno-upload uploads ${subCommandName}`,
        version,
      });
      return;
    }

    if (args[0] === "files") {
      const subCommandName = args[1];
      if (!subCommandName || subCommandName === "--help" || subCommandName === "-h") {
        printFilesHelp();
        return;
      }
      if (subCommandName === "--version" || subCommandName === "-v") {
        console.log(version);
        return;
      }

      const subCommand = filesSubCommands.get(subCommandName);
      if (!subCommand) {
        console.error(`Unknown command: ${subCommandName}`);
        console.log("");
        console.log("Run 'fragno-upload files --help' for available commands.");
        process.exit(1);
      }

      await cli(args.slice(2), subCommand, {
        name: `fragno-upload files ${subCommandName}`,
        version,
      });
      return;
    }

    console.error(`Unknown command: ${args[0]}`);
    console.log("");
    console.log("Run 'fragno-upload --help' for available commands.");
    process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await run();
}

export {
  uploadsCreateCommand,
  uploadsGetCommand,
  uploadsProgressCommand,
  uploadsPartsUrlsCommand,
  uploadsPartsListCommand,
  uploadsPartsCompleteCommand,
  uploadsCompleteCommand,
  uploadsAbortCommand,
  uploadsContentCommand,
  uploadsTransferCommand,
  filesUploadCommand,
  filesListCommand,
  filesGetCommand,
  filesUpdateCommand,
  filesDeleteCommand,
  filesDownloadUrlCommand,
  filesDownloadCommand,
};
