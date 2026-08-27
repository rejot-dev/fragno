import { spawn } from "node:child_process";

type BackofficeBrowserOpenCommand = readonly [command: string, args: readonly string[]];

/** Resolves a shell-free browser command for an HTTP or HTTPS verification URL. */
export function resolveBackofficeVerificationBrowserCommand(
  value: string,
  platform: NodeJS.Platform,
): BackofficeBrowserOpenCommand | null {
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(value);
  } catch {
    return null;
  }
  if (verificationUrl.protocol !== "http:" && verificationUrl.protocol !== "https:") {
    return null;
  }

  const url = verificationUrl.toString();
  if (platform === "darwin") {
    return ["open", [url]];
  }
  if (platform === "win32") {
    return ["explorer.exe", [url]];
  }
  return ["xdg-open", [url]];
}

/** Opens a validated Backoffice device verification URL in the default browser. */
export function openBackofficeVerificationUrl(value: string): void {
  const command = resolveBackofficeVerificationBrowserCommand(value, process.platform);
  if (!command) {
    return;
  }

  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    console.error(`Could not open the browser automatically: ${error.message}`);
  });
  child.unref();
}
