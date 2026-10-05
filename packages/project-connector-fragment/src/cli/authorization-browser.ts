/** Selects a shell-free browser launcher so OAuth query parameters remain literal arguments. */
export function resolveAuthorizationBrowserLaunch(platform: NodeJS.Platform, url: string) {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}
