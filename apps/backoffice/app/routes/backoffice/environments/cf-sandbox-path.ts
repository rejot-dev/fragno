export type CfSandboxView = "new" | "detail";

type CfSandboxPathOptions = { view?: "new" } | { view: "detail"; sandboxId: string };

export function toCfSandboxPath(options: CfSandboxPathOptions) {
  const params = new URLSearchParams();
  switch (options.view) {
    case "new":
      params.set("view", "new");
      break;
    case "detail":
      params.set("sandbox", options.sandboxId);
      break;
    default:
      break;
  }

  const query = params.toString();
  return query
    ? `/backoffice/environments/cf-sandbox?${query}`
    : "/backoffice/environments/cf-sandbox";
}
